import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MANIFEST_ACCEPT = "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json";
const HELM_CHART_LAYER = "application/vnd.cncf.helm.chart.content.v1.tar+gzip";
const PAGE_SIZE = 100;
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Returns true when `host` (optionally with a port) is the local machine. Plain http is only ever allowed there.
 */
export function isLoopback(host) {
  return LOOPBACK_HOST.test(host);
}

/**
 * Returns the sha256 digest of a buffer in OCI form, e.g. sha256:ab12....
 */
function sha256Digest(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

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
    // Plain http would expose the credentials; only the local test registry may use it
    if (scheme !== "https" && !(scheme === "http" && isLoopback(host))) {
      throw new RegistryError(`refusing to talk to ${host} over ${scheme}; only https is supported`);
    }

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

    // The credentials go to the realm, so it must be https (http only for the local test registry)
    let url;
    try {
      url = new URL(realm);
    } catch {
      throw new RegistryError(`${this.host} advertised an invalid token realm`);
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && this.scheme === "http" && isLoopback(url.host))) {
      throw new RegistryError(`${this.host} advertised a token realm that is not https (${url.origin}); refusing to send credentials`);
    }

    // Exchange the basic credentials for a token limited to pulling this repository
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
   * Performs an authenticated GET on the registry's own origin; `target` may be absolute or registry-relative.
   * Refuses any other origin so the token never leaves the registry. Maps 401/403 to a clear error.
   */
  async get(target, headers = {}) {
    const url = new URL(target, this.baseUrl);
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new RegistryError(`${this.host} pointed to another host (${url.origin}); refusing to send the registry token there`);
    }
    const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${this.token}`, ...headers } });
    if (res.status === 401 || res.status === 403) {
      throw new RegistryError(`${this.host} refused access to ${this.repo} (HTTP ${res.status}). Check the registry username and password.`);
    }
    return res;
  }

  /**
   * Fetches a tag's manifest and returns { body, digest }, or null when the tag does not exist. The digest is
   * computed from the body; a registry digest header that disagrees with it is an error.
   */
  async fetchManifest(tag) {
    const res = await this.get(`/v2/${this.repo}/manifests/${tag}`, { accept: MANIFEST_ACCEPT });
    if (res.status === 404) return null;
    if (!res.ok) throw new RegistryError(`unexpected HTTP ${res.status} fetching ${this.repo}:${tag}`);

    // Hash what was received rather than trusting the header
    const body = Buffer.from(await res.arrayBuffer());
    const digest = sha256Digest(body);
    const header = res.headers.get("docker-content-digest");
    if (header && header !== digest) {
      throw new RegistryError(`${this.repo}:${tag} failed its integrity check: the registry says ${header}, the manifest hashes to ${digest}`);
    }
    return { body, digest };
  }

  /**
   * Returns the manifest digest for a tag, or null when the tag does not exist.
   */
  async digestOf(tag) {
    return (await this.fetchManifest(tag))?.digest ?? null;
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
   * Downloads the Helm chart layer of a tag into destDir and returns the .tgz path. The file is kept only
   * when its sha256 matches the layer digest in the manifest.
   */
  async downloadChart(tag, destDir) {
    // Find the chart layer in the integrity-checked manifest
    const found = await this.fetchManifest(tag);
    if (!found) throw new RegistryError(`${this.repo}:${tag} does not exist`);
    const manifest = JSON.parse(found.body.toString("utf8"));
    const layer = (manifest.layers ?? []).find((l) => l.mediaType === HELM_CHART_LAYER);
    if (!layer) throw new RegistryError(`${this.repo}:${tag} has no Helm chart layer`);
    if (!/^sha256:[0-9a-f]{64}$/.test(layer.digest ?? "")) throw new RegistryError(`${this.repo}:${tag} has a chart layer without a sha256 digest`);

    // Stream the blob to disk under the same name helm pull would use, hashing it on the way
    const blob = await this.get(`/v2/${this.repo}/blobs/${layer.digest}`);
    if (!blob.ok) throw new RegistryError(`unexpected HTTP ${blob.status} downloading ${this.repo}:${tag}`);
    await mkdir(destDir, { recursive: true });
    const file = path.join(destDir, `${this.chartName}-${tag}.tgz`);
    const hash = createHash("sha256");
    const source = Readable.fromWeb(blob.body);
    source.on("data", (chunk) => hash.update(chunk));
    await pipeline(source, createWriteStream(file));

    // Drop the file if it is not the blob the manifest names
    const actual = `sha256:${hash.digest("hex")}`;
    if (actual !== layer.digest) {
      await rm(file, { force: true });
      throw new RegistryError(`${this.repo}:${tag} chart failed its integrity check: expected ${layer.digest}, got ${actual}`);
    }
    return file;
  }
}
