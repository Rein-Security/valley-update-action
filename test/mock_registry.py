"""
Minimal OCI registry mock for resolve.sh tests: bearer auth, paginated tag list, digests per tag.
"""
import base64, json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1])
DIGESTS = {"stable": "sha256:aaa", "0.61.0": "sha256:aaa", "0.62.0": "sha256:bbb", "0.60.0": "sha256:ccc", "0.59.0": "sha256:ddd", "0.60.0-alpha.3": "sha256:eee", "0.62.0-rc.1": "sha256:fff"}
PAGE1 = ["0.59.0", "0.60.0-alpha.3", "0.60.0"]
PAGE2 = ["0.61.0", "0.62.0-rc.1", "0.62.0", "stable"]


class H(BaseHTTPRequestHandler):
    """
    Serves the handful of registry endpoints resolve.sh touches.
    """

    def log_message(self, *a):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/v2/":
            self.send_response(401)
            self.send_header("Www-Authenticate", f'Bearer realm="http://127.0.0.1:{PORT}/service/token",service="harbor-registry"')
            self.end_headers(); return
        if u.path == "/service/token":
            auth = self.headers.get("Authorization", "")
            ok = auth.startswith("Basic ") and base64.b64decode(auth[6:]).decode() == "robot$abc:s3cret"
            if not ok:
                self.send_response(401); self.end_headers(); return
            body = json.dumps({"token": "tok123"}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body); return
        if self.headers.get("Authorization") != "Bearer tok123":
            self.send_response(401); self.end_headers(); return
        if u.path == "/v2/valley/valley/tags/list":
            if "last" in q:
                body = json.dumps({"name": "valley/valley", "tags": PAGE2}).encode()
                self.send_response(200); self.end_headers(); self.wfile.write(body); return
            body = json.dumps({"name": "valley/valley", "tags": PAGE1}).encode()
            self.send_response(200); self.send_header("Link", '</v2/valley/valley/tags/list?n=100&last=0.60.0>; rel="next"'); self.end_headers(); self.wfile.write(body); return
        if u.path.startswith("/v2/valley/valley/manifests/"):
            tag = u.path.rsplit("/", 1)[1]
            if tag in DIGESTS:
                self.send_response(200); self.send_header("Docker-Content-Digest", DIGESTS[tag]); self.end_headers(); return
            self.send_response(404); self.end_headers(); return
        if u.path.startswith("/v2/valley/valley-alpha/"):
            self.send_response(404); self.end_headers(); return
        self.send_response(404); self.end_headers()


HTTPServer(("127.0.0.1", PORT), H).serve_forever()
