import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MANIFEST_ACCEPT = "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json";
const HELM_CHART_LAYER = "application/vnd.cncf.helm.chart.content.v1.tar+gzip";
const PAGE_SIZE = 100;

/**
 * Error raised for registry problems the customer can act on (bad credentials, missing tag).
 */
export class RegistryError extends Error {}

/**
 * Minimal OCI distribution client for one repository, using a pull-only bearer token.
 */
export class Registry {
  /**
   * Creates a client for `repo` on `host`; `scheme` and `fetchImpl` exist for tests.
   */
  constructor({ host, repo, username, password, scheme = "https", fetchImpl = globalThis.fetch }) {
    this.host = host;
    this.repo = repo;
    this.username = username;
    this.password = password;
    this.scheme = scheme;
    this.fetchImpl = fetchImpl;
    this.token = null;
  }

  /**
   * Returns the registry base URL, e.g. https://hub.reinsec.app.
   */
  get baseUrl() {
    return `${this.scheme}://${this.host}`;
  }

  /**
   * Returns the chart name, which is the last path segment of the repository.
   */
  get chartName() {
    return this.repo.split("/").pop();
  }

  /**
   * Fetches a pull-scoped bearer token from the realm the registry advertises on /v2/.
   */
  async login() {
    // Ask the registry where its token service lives
    const probe = await this.fetchImpl(`${this.baseUrl}/v2/`);
    const challenge = probe.headers.get("www-authenticate") ?? "";
    const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
    const service = /service="([^"]+)"/.exec(challenge)?.[1] ?? "";
    if (!realm) throw new RegistryError(`${this.host} did not offer bearer authentication on /v2/`);

    // Exchange the basic credentials for a token limited to pulling this repository
    const url = new URL(realm);
    url.searchParams.set("service", service);
    url.searchParams.set("scope", `repository:${this.repo}:pull`);
    const basic = Buffer.from(`${this.username}:${this.password}`).toString("base64");
    const res = await this.fetchImpl(url, { headers: { authorization: `Basic ${basic}` } });
    if (!res.ok) throw new RegistryError(`${this.host} rejected the credentials (HTTP ${res.status}). Check the registry username and password.`);

    const body = await res.json();
    this.token = body.token ?? body.access_token ?? null;
    if (!this.token) throw new RegistryError(`${this.host} returned no token. Check the registry username and password.`);
    return this.token;
  }

  /**
   * Performs an authenticated GET; `target` may be absolute or registry-relative. Maps 401/403 to a clear error.
   */
  async get(target, headers = {}) {
    const url = target.startsWith("http") ? target : `${this.baseUrl}${target}`;
    const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${this.token}`, ...headers } });
    if (res.status === 401 || res.status === 403) {
      throw new RegistryError(`${this.host} refused access to ${this.repo} (HTTP ${res.status}). Check the registry username and password.`);
    }
    return res;
  }

  /**
   * Returns the manifest digest for a tag, or null when the tag does not exist.
   */
  async digestOf(tag) {
    const res = await this.get(`/v2/${this.repo}/manifests/${tag}`, { accept: MANIFEST_ACCEPT });
    if (res.status === 404) return null;
    if (!res.ok) throw new RegistryError(`unexpected HTTP ${res.status} fetching ${this.repo}:${tag}`);

    // Prefer the header; hash the body when a registry omits it
    const body = Buffer.from(await res.arrayBuffer());
    return res.headers.get("docker-content-digest") ?? `sha256:${createHash("sha256").update(body).digest("hex")}`;
  }

  /**
   * Lists every tag in the repository, following Link pagination.
   */
  async listTags() {
    const tags = [];
    let next = `/v2/${this.repo}/tags/list?n=${PAGE_SIZE}`;
    while (next) {
      const res = await this.get(next);
      if (!res.ok) throw new RegistryError(`unexpected HTTP ${res.status} listing tags of ${this.repo}`);
      const body = await res.json();
      tags.push(...(body.tags ?? []));
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
    }
    return tags;
  }

  /**
   * Downloads the Helm chart layer of a tag into destDir and returns the .tgz path.
   */
  async downloadChart(tag, destDir) {
    // Find the chart layer in the manifest
    const res = await this.get(`/v2/${this.repo}/manifests/${tag}`, { accept: MANIFEST_ACCEPT });
    if (!res.ok) throw new RegistryError(`unexpected HTTP ${res.status} fetching ${this.repo}:${tag}`);
    const manifest = await res.json();
    const layer = (manifest.layers ?? []).find((l) => l.mediaType === HELM_CHART_LAYER);
    if (!layer) throw new RegistryError(`${this.repo}:${tag} has no Helm chart layer`);

    // Stream the blob to disk under the same name helm pull would use
    const blob = await this.get(`/v2/${this.repo}/blobs/${layer.digest}`);
    if (!blob.ok) throw new RegistryError(`unexpected HTTP ${blob.status} downloading ${this.repo}:${tag}`);
    await mkdir(destDir, { recursive: true });
    const file = path.join(destDir, `${this.chartName}-${tag}.tgz`);
    await pipeline(Readable.fromWeb(blob.body), createWriteStream(file));
    return file;
  }
}
