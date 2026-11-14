"""Which failure is Firefox blaming on the service worker?

A reader reported, on a big `/api/pins/map?limit=2000` request:

    Failed to load 'https://xyzo.org/api/pins/map?bbox=…'.
    A ServiceWorker intercepted the request and encountered an
    unexpected error.  sw.js:491:11

The line always quotes `event.respondWith(...)` — the worker's own
call site — so it says nothing about WHAT failed. Firefox uses two
different wordings, and the wording is the diagnosis:

  · "A ServiceWorker passed an Error Response to FetchEvent.respondWith().
     This typically means the ServiceWorker performed an invalid fetch()
     call"      -> the request never completed; networkFirst() returned
                   Response.error() (no cached copy to fall back on).
  · "A ServiceWorker intercepted the request and encountered an
     unexpected error."   -> the response STARTED and its BODY failed
                   — a truncated transfer. Measured on a 630 KB answer.

Both are ordinary network failures and the page's own retry/banner
path handles them; the worker is not broken. Firefox's wording is
misleading ("invalid fetch() call") but it is not ours to edit.

WHY THIS SCRIPT EXISTS: `navigator.serviceWorker.controller` is not
proof that a fetch was intercepted. Measured on Playwright's Firefox
153: `wait_for_function` reports active + controlling, and the very
NEXT fetch still bypasses the worker (404 straight from the origin) —
while a later fetch is intercepted. Four runs were read as "no console
blame" when in fact nothing had been intercepted at all. So every
scenario here proves interception FIRST with a marker path the plain
origin 404s and only the worker can answer.

  python3 scripts/sw_console_audit.py            # firefox, headless
  python3 scripts/sw_console_audit.py --port 8877

Exits non-zero only when the harness itself is broken (the worker
never intercepted), never on the browser's wording.
"""
import http.server
import socket
import sys
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SW_JS = REPO / "public_html" / "sw.js"
PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8882

ANCHOR = "event.respondWith(networkFirst(request, API_CACHE).catch(() => networkError()));"
# The marker goes INSIDE the /api/ branch — the branch it belongs to —
# on a path the plain origin answers 404, so a 200 can only be the worker.
PROBE = ("if (url.pathname.startsWith('/api/__audit_probe')) {\n"
         "      event.respondWith(new Response('handled-by-sw', "
         "{status: 200, headers: {'Content-Type': 'text/plain'}}));\n"
         "      return;\n    }\n    ")

INDEX = """<!doctype html><meta charset=utf-8><title>xyzo sw audit</title>
<body style="background:#111;color:#eee;font:14px sans-serif">sw console audit</body>
<script>navigator.serviceWorker.register('/sw.js');</script>"""


def sw_source():
    text = SW_JS.read_text(encoding="utf-8")
    if ANCHOR not in text:
        raise SystemExit(f"anchor not found in {SW_JS} — sw.js changed shape; "
                         "update ANCHOR in this script")
    return text.replace(ANCHOR, PROBE + ANCHOR)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, ctype, body, status=200):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            self._send("text/html; charset=utf-8", INDEX.encode())
            return
        if path == "/sw.js":
            body = sw_source().encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)
            return
        if path.startswith("/api/warm"):
            self._send("application/json", b'{"ok":true}')
            return
        if path.startswith("/api/reset"):
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.connection.close()
            self.close_connection = True
            return
        if path.startswith("/api/trunc"):
            # Headers promise a big answer, then the connection dies —
            # the 630 KB pins/map response cut short mid-transfer.
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Content-Length", "100000")
            self.end_headers()
            try:
                self.wfile.write(b'{"meta":{"ok":true}}\n' + b"x" * 5000)
                self.wfile.flush()
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.connection.close()
            self.close_connection = True
            return
        self._send("text/plain", b"nope", status=404)   # incl. __audit_probe


def wording(msg):
    """Firefox's two verdicts, and the reader-facing translation."""
    if "Error Response" in msg:
        return "REQUEST NEVER COMPLETED (connection failed; Response.error())"
    if "encountered an unexpected error" in msg:
        return "BODY DIED MID-TRANSFER (truncated response)"
    return "other"


def main() -> int:
    from playwright.sync_api import sync_playwright

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    failures = 0
    with sync_playwright() as p:
        browser = p.firefox.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1024, "height": 768})
        page = ctx.new_page()
        msgs = []
        page.on("console", lambda m: msgs.append((m.type, m.text)))
        page.goto(f"http://127.0.0.1:{PORT}/", wait_until="load", timeout=60000)
        page.wait_for_function(
            """async () => { const r = await navigator.serviceWorker.getRegistration();
                 return !!(r && r.active && navigator.serviceWorker.controller); }""",
            timeout=60000)

        # The warm request is what puts the worker into the fetch
        # pipeline on this browser; every scenario proves it afterwards.
        page.evaluate("""async () => { try { await fetch('/api/warm?n=' + Math.random(),
            {cache: 'no-store'}); } catch (e) {} }""")

        def intercepted_once():
            out = page.evaluate("""async () => {
                try { const r = await fetch('/api/__audit_probe?n=' + Math.random(),
                                           {cache: 'no-store'});
                      return r.status + ' ' + (await r.text()); }
                catch (e) { return 'THREW ' + e.name; } }""")
            return "handled-by-sw" in out

        def ensure_intercepted(seconds=25):
            """Wait for the worker to actually enter the fetch pipeline.

            Measured: right after `controller` is truthy, the next fetch
            still goes straight to the origin. The probe returns 404 from
            the origin until the worker engages — sometimes only after a
            few requests and a couple of seconds. A single check reads
            that as "not intercepted" and voids the whole run (it did,
            four times), so warm the path and poll.
            """
            deadline = time.time() + seconds
            while time.time() < deadline:
                page.evaluate("""async () => { try { await fetch('/api/warm?n=' +
                    Math.random(), {cache: 'no-store'}); } catch (e) {} }""")
                if intercepted_once():
                    return True
                page.wait_for_timeout(400)
            return False

        if not ensure_intercepted():
            print("  ✗ the worker never intercepted a fetch in this run — "
                  "harness failure, nothing measured")
            ctx.close()
            browser.close()
            srv.shutdown()
            return 1

        for label, path in [
            ("connection reset before the response", "/api/reset"),
            ("body cut short mid-transfer", "/api/trunc"),
        ]:
            proved = intercepted_once()
            if not proved:
                # the worker dropped out mid-run: re-establish or bail
                if ensure_intercepted():
                    proved = intercepted_once()
            if not proved:
                print(f"  ✗ {label}: the worker did NOT intercept — "
                      "this run measures nothing (harness bug)")
                failures += 1
                continue
            msgs.clear()
            out = page.evaluate(
                """async (u) => {
                    try { const r = await fetch(u + '?n=' + Math.random(),
                                                {cache: 'no-store'});
                          const t = await r.text();
                          return 'HTTP ' + r.status + ' body=' + t.length; }
                    catch (e) { return 'THREW ' + e.name; } }""", path)
            page.wait_for_timeout(4000)
            blame = [m for m in msgs
                     if "ServiceWorker" in m[1] or "Failed to load" in m[1]]
            print(f"\n  {label}")
            print(f"      interception proven : {proved}")
            print(f"      page saw            : {out}")
            if not blame:
                print("      console             : clean (no worker blamed)")
            for _t, x in blame:
                print(f"      console             : {wording(x)}")
                print(f"        {x[:200]}")
        ctx.close()
        browser.close()
    srv.shutdown()
    print("\n  verdict: the two wordings are ordinary network failures seen")
    print("  through the worker — the worker is not broken. Firefox owns")
    print("  the text; our page's retry + banner path owns the outcome.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
