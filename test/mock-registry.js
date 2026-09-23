import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";

const TOKEN = "tok123";
export const MOCK_USER = "robot$abc";
export const MOCK_PASSWORD = "s3cret";
export const CHART_BYTES = gzipSync(Buffer.from("fake chart tarball"));
const HELM_CHART_LAYER = "application/vnd.cncf.helm.chart.content.v1.tar+gzip";

/**
 * Returns the sha256 digest of a buffer in OCI form.
 */
function sha256Digest(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

const CHART_DIGEST = sha256Digest(CHART_BYTES);

/**
 * Builds a manifest body for one artifact; `artifact` makes each body, and so each digest, distinct.
 */
function manifestBody(artifact, layerDigest = CHART_DIGEST) {
  return Buffer.from(JSON.stringify({ schemaVersion: 2, annotations: { artifact }, layers: [{ mediaType: HELM_CHART_LAYER, digest: layerDigest, size: CHART_BYTES.length }] }));
}

// Tags sharing an artifact share a digest; "stable" and 0.61.0 are one artifact so the resolver must pick 0.61.0, not the highest tag
const ARTIFACTS = {
  stable: "a",
  "0.61.0": "a",
  "0.62.0": "b",
  "0.60.0": "c",
  "0.59.0": "d",
  "0.60.0-alpha.3": "e",
  "0.62.0-rc.1": "f",
};
const PAGE1 = ["0.59.0", "0.60.0-alpha.3", "0.60.0"];
const PAGE2 = ["0.61.0", "0.62.0-rc.1", "0.62.0", "stable"];

// Tampered artifacts, reachable only by name: a lying digest header, and a layer digest the blob does not match
const BAD_HEADER = "bad-header";
const BAD_BLOB = "bad-blob";
const BAD_BLOB_DIGEST = sha256Digest(Buffer.from("some other blob"));

/**
 * Sends a JSON body with the given status and extra headers.
 */
function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Starts a mock OCI registry that mimics Harbor's bearer auth, paginated tag list, manifests, and one chart blob. Returns { port, close }.
 */
export async function startMockRegistry() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const port = server.address().port;

    // Auth challenge and token exchange
    if (url.pathname === "/v2/") {
      res.writeHead(401, { "www-authenticate": `Bearer realm="http://127.0.0.1:${port}/service/token",service="harbor-registry"` });
      return res.end();
    }
    if (url.pathname === "/service/token") {
      const auth = req.headers.authorization ?? "";
      const creds = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString() : "";
      if (creds !== `${MOCK_USER}:${MOCK_PASSWORD}`) return json(res, 401, { errors: [{ code: "UNAUTHORIZED" }] });
      return json(res, 200, { token: TOKEN });
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { errors: [{ code: "UNAUTHORIZED" }] });

    // Tag list in two pages
    if (url.pathname === "/v2/valley/valley/tags/list") {
      if (url.searchParams.has("last")) return json(res, 200, { name: "valley/valley", tags: PAGE2 });
      return json(res, 200, { name: "valley/valley", tags: PAGE1 }, { link: `</v2/valley/valley/tags/list?n=100&last=0.60.0>; rel="next"` });
    }

    // Manifests carry the digest header and a Helm chart layer
    const manifest = /^\/v2\/valley\/valley\/manifests\/(.+)$/.exec(url.pathname);
    if (manifest) {
      const tag = manifest[1];
      let body;
      let digest;
      if (tag === BAD_HEADER) {
        body = manifestBody("tampered");
        digest = sha256Digest(manifestBody("a"));
      } else if (tag === BAD_BLOB) {
        body = manifestBody("bad-blob", BAD_BLOB_DIGEST);
        digest = sha256Digest(body);
      } else if (ARTIFACTS[tag]) {
        body = manifestBody(ARTIFACTS[tag]);
        digest = sha256Digest(body);
      } else {
        return json(res, 404, { errors: [{ code: "MANIFEST_UNKNOWN" }] });
      }
      res.writeHead(200, { "content-type": "application/vnd.oci.image.manifest.v1+json", "docker-content-digest": digest });
      return res.end(body);
    }

    // Both blob digests serve the same bytes, so only CHART_DIGEST matches what arrives
    if (url.pathname === `/v2/valley/valley/blobs/${CHART_DIGEST}` || url.pathname === `/v2/valley/valley/blobs/${BAD_BLOB_DIGEST}`) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(CHART_BYTES);
    }

    // The alpha repository has nothing promoted
    return json(res, 404, { errors: [{ code: "NOT_FOUND" }] });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

export { BAD_BLOB, BAD_HEADER, sha256Digest };
