"""Local server for EWC Live Timing.

Serves this folder like `python -m http.server`, plus a same-origin relay for
the timing feed. The feed moved to ewc.chronelec.com, which sends no CORS
headers, so a browser page can't fetch it directly. The app requests
/feed/<name> and this server fetches it upstream.

Usage:  python serve.py [port]      (default port 3800)
"""
import functools
import http.server
import os
import sys
import urllib.request

UPSTREAM = 'https://ewc.chronelec.com/'
ALLOWED = {'results.php', 'messages.php'}
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/feed/'):
            self.relay(self.path[len('/feed/'):].split('?', 1)[0])
        else:
            super().do_GET()

    def relay(self, name):
        if name not in ALLOWED:
            self.send_error(404, 'Unknown feed')
            return
        try:
            req = urllib.request.Request(UPSTREAM + name, headers={'User-Agent': 'Mozilla/5.0 (ewc-livetiming relay)'})
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = resp.read()
        except Exception as exc:  # upstream down/slow: report it, keep serving
            self.send_error(502, f'Upstream error: {exc}')
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # Never cache: the page and the feed must always be the latest version.
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.path.startswith('/feed/'):  # keep the 5-second feed polls out of the log
            super().log_message(fmt, *args)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3800
    server = http.server.ThreadingHTTPServer(('', port), functools.partial(Handler, directory=ROOT))
    print(f'EWC Live Timing on http://localhost:{port}  (feed relay: /feed/results.php)')
    server.serve_forever()
