"""Static file server + a tiny proxy that asks Claude to turn Wikipedia text into facts.
Your API key stays on your machine (never sent to the browser).

Run:  python server.py        (needs ANTHROPIC_API_KEY set; without it the app falls back to plain Wikipedia sentences)
"""
import json, os, urllib.request, urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

KEY = os.environ.get("ANTHROPIC_API_KEY")
MODEL = os.environ.get("CLAUDE_MODEL", "claude-haiku-5-5")
PORT = 5173

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
    print(f"Serving on http://127.0.0.1:{PORT}/  |  Claude facts: {'ON (' + MODEL + ')' if KEY else 'OFF (set ANTHROPIC_API_KEY)'}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
