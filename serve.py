"""Local server for EWC Live Timing.

Serves this folder like `python -m http.server`, plus a same-origin relay for
the timing feed. The feed moved to ewc.chronelec.com, which sends no CORS
headers, so a browser page can't fetch it directly. The app requests
/feed/<name> and this server fetches it upstream.

It also takes POST /save-data/<name>: the page posts a packed session there
(saveRaceFile() in the console) and it lands in data/<name>.json with the
manifest data/index.json refreshed, so a recorded race can be committed with
the app and opened anywhere as ?race=<name>.

Usage:  python serve.py [port]      (default port 3800)
"""
import functools
import http.server
import json
import os
import re
import sys
import urllib.request

UPSTREAM = 'https://ewc.chronelec.com/'
ALLOWED = {'results.php', 'messages.php'}
ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, 'data')
NAME_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}$')
MAX_UPLOAD = 128 * 1024 * 1024


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/feed/'):
            self.relay(self.path[len('/feed/'):].split('?', 1)[0])
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith('/save-data/'):
            self.save_data(self.path[len('/save-data/'):].split('?', 1)[0])
        else:
            self.send_error(404, 'Unknown endpoint')

    def save_data(self, name):
        """Write a session the page posted into data/<name>.json."""
        name = name[:-5] if name.endswith('.json') else name
        if not NAME_RE.match(name or ''):
            self.send_error(400, 'Bad file name')
            return
        length = int(self.headers.get('Content-Length') or 0)
        if not 0 < length <= MAX_UPLOAD:
            self.send_error(413, 'Bad content length')
            return
        body = self.rfile.read(length)
        try:
            obj = json.loads(body)
        except ValueError as exc:
            self.send_error(400, f'Not JSON: {exc}')
            return
        os.makedirs(DATA, exist_ok=True)
        with open(os.path.join(DATA, name + '.json'), 'wb') as fh:
            fh.write(body)
        self.write_index(name, obj, len(body))
        self.send_json({'ok': True, 'file': f'data/{name}.json', 'bytes': len(body)})

    def write_index(self, name, obj, size):
        """Refresh data/index.json: what the app's session picker lists."""
        teams = obj.get('teams') or {}
        laps = sum(len(t.get('laps') or []) for t in teams.values())
        t0, last = obj.get('t0') or 0, 0
        for team in teams.values():
            for lap in team.get('laps') or []:
                if len(lap) > 1 and isinstance(lap[1], (int, float)):
                    last = max(last, lap[1])
        entry = {'file': name + '.json', 'key': obj.get('key', ''), 'title': obj.get('title', name),
                 'event': obj.get('event', ''), 'session': obj.get('session', ''),
                 'savedAt': obj.get('savedAt'), 'tz': obj.get('tz'), 'teams': len(teams), 'laps': laps,
                 'start': t0, 'end': t0 + last, 'bytes': size}
        path = os.path.join(DATA, 'index.json')
        try:
            with open(path, encoding='utf-8') as fh:
                index = [e for e in json.load(fh) if e.get('file') != entry['file']]
        except (OSError, ValueError):
            index = []
        index.append(entry)
        index.sort(key=lambda e: e.get('start') or 0)
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(index, fh, indent=1)

    def send_json(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
