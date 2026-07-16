"""Local dev server for the web app: python serve.py [port]
Serves docs/ with caching disabled so edits always show on a normal refresh.
"""

import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs"))
    with http.server.ThreadingHTTPServer(("", port), NoCacheHandler) as httpd:
        print(f"serving docs/ at http://localhost:{port} (cache disabled)")
        httpd.serve_forever()
