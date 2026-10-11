"""Static file server + a tiny proxy that asks Claude to turn Wikipedia text into facts.
Your API key stays on your machine (never sent to the browser).

Run:  python server.py        (needs ANTHROPIC_API_KEY set; without it the app falls back to plain Wikipedia sentences)
"""
import json, os, posixpath, time, urllib.request, urllib.error
from collections import defaultdict, deque
from urllib.parse import unquote
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

KEY = os.environ.get("ANTHROPIC_API_KEY")
MODEL = os.environ.get("CLAUDE_MODEL", "claude-haiku-5-5")
# Hosting platforms set PORT; locally we stay on 127.0.0.1:5173
PORT = int(os.environ.get("PORT", 5173))
HOST = "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1"

# Protect your API bill when the site is public: max Claude requests per visitor / overall, per hour
PER_IP_LIMIT = int(os.environ.get("PER_IP_LIMIT", 40))
GLOBAL_LIMIT = int(os.environ.get("GLOBAL_LIMIT", 400))
hits = defaultdict(deque)
all_hits = deque()


def rate_limited(ip):
    now = time.time()
    for q in (hits[ip], all_hits):
        while q and now - q[0] > 3600:
            q.popleft()
    if len(hits[ip]) >= PER_IP_LIMIT or len(all_hits) >= GLOBAL_LIMIT:
        return True
    hits[ip].append(now)
    all_hits.append(now)
    return False

PROMPT = """Below is Wikipedia text that should be about the music artist "{artist}".

First check: if the text is NOT about this artist (it's a different person, an album, a song, a place, etc.), return [] and nothing else.

Otherwise write 8 interesting, surprising facts about {artist} using ONLY information in the text.
Rules:
- One sentence each, under 200 characters, conversational and specific (names, numbers, places).
- Every fact must name or clearly be about {artist}. No generic music-history trivia.
- No dull career-summary lines, no "is a band formed in...". Prefer odd details, firsts, records, stories.
- Do not invent anything that isn't in the text.
- Do not repeat or rephrase any of these already-used facts: {avoid}
Return ONLY a JSON array of strings.

TEXT:
{extract}"""


class Handler(SimpleHTTPRequestHandler):
    # Only the web app's own files are public (never server.py or .env)
    def allowed(self):
        p = posixpath.normpath(unquote(self.path.split("?")[0]))
        return p in ("/", "/index.html", "/styles.css") or p.startswith("/src/")

    def do_GET(self):
        if not self.allowed():
            return self.send_error(404)
        super().do_GET()

    def do_HEAD(self):
        if not self.allowed():
            return self.send_error(404)
        super().do_HEAD()

    def reply(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # no more stale config.js
        super().end_headers()

    def do_POST(self):
        if self.path != "/api/facts":
            return self.send_error(404)
        if not KEY:
            return self.reply(503, {"error": "ANTHROPIC_API_KEY is not set"})
        ip = self.headers.get("X-Forwarded-For", self.client_address[0]).split(",")[0].strip()
        if rate_limited(ip):
            return self.reply(429, {"error": "Too many requests, try again later"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            avoid = json.dumps(body.get("avoid", [])[:30])
            req = urllib.request.Request(
                "https://api.anthropic.com/v1/messages",
                data=json.dumps({
                    "model": MODEL,
                    "max_tokens": 4000,
                    "messages": [{"role": "user", "content": PROMPT.format(
                        artist=body["artist"][:100], extract=body["extract"][:8000], avoid=avoid)}],
                }).encode(),
                headers={"x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=40) as r:
                blocks = json.loads(r.read())["content"]
                text = "".join(b["text"] for b in blocks if b.get("type") == "text")
            facts = json.loads(text[text.index("["): text.rindex("]") + 1])
            self.reply(200, {"facts": [f for f in facts if isinstance(f, str)]})
        except urllib.error.HTTPError as e:
            self.reply(502, {"error": f"Anthropic API error {e.code}: {e.read().decode()[:300]}"})
        except Exception as e:
            import traceback; traceback.print_exc()
            self.reply(500, {"error": repr(e)})


if __name__ == "__main__":
    print(f"Serving on http://{HOST}:{PORT}/  |  Claude facts: {'ON (' + MODEL + ')' if KEY else 'OFF (set ANTHROPIC_API_KEY)'}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
