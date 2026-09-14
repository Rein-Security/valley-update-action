import { createServer } from "node:http";
import { gzipSync } from "node:zlib";

const TOKEN = "tok123";
export const MOCK_USER = "robot$abc";
export const MOCK_PASSWORD = "s3cret";
export const CHART_BYTES = gzipSync(Buffer.from("fake chart tarball"));
const CHART_DIGEST = "sha256:chartblob";

// Two digests share the "stable" pointer's target so the resolver must pick 0.61.0, not the highest tag
const DIGESTS = {
  stable: "sha256:aaa",
  "0.61.0": "sha256:aaa",
  "0.62.0": "sha256:bbb",
  "0.60.0": "sha256:ccc",
  "0.59.0": "sha256:ddd",
  "0.60.0-alpha.3": "sha256:eee",
  "0.62.0-rc.1": "sha256:fff",
};
const PAGE1 = ["0.59.0", "0.60.0-alpha.3", "0.60.0"];
const PAGE2 = ["0.61.0", "0.62.0-rc.1", "0.62.0", "stable"];

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
      const digest = DIGESTS[manifest[1]];
      if (!digest) return json(res, 404, { errors: [{ code: "MANIFEST_UNKNOWN" }] });
      const body = { schemaVersion: 2, layers: [{ mediaType: "application/vnd.cncf.helm.chart.content.v1.tar+gzip", digest: CHART_DIGEST, size: CHART_BYTES.length }] };
      return json(res, 200, body, { "docker-content-digest": digest });
    }
    if (url.pathname === `/v2/valley/valley/blobs/${CHART_DIGEST}`) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(CHART_BYTES);
    }

    // The alpha repository has nothing promoted
    return json(res, 404, { errors: [{ code: "NOT_FOUND" }] });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}
