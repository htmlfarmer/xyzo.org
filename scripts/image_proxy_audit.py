"""
The IMAGE PROXY: does it ever answer an error status?

The owner reported: *"image-proxy:1  Failed to load resource: the
server responded with a status of 404 ()"*.

A dead picture is gone AT THE PUBLISHER — the reader can neither
silence that nor act on it — and a failed subresource is logged by the
BROWSER, so no JavaScript can suppress it. The proxy therefore answers
a dead picture with **HTTP 200 and a 1x1 transparent PNG**.

This audit drives the real page: it loads it, opens a few story
popups, scrolls the live feed, and records **every** response the
image proxy makes, with its status. The only acceptable statuses are
200 (the picture, or the placeholder) and 400 (a malformed request —
about the request, not about a missing picture).

Run:  python3 scripts/image_proxy_audit.py
"""
import collections
import json
import urllib.parse
import urllib.request
import concurrent.futures
import time

PROXY = "http://localhost:3008/api/image-proxy?url="


def probe(urls):
    """Ask the proxy about a list of stored image URLs, slowly enough
    to stay inside the rate limit (it is per IP, and this box shares
    one with the site)."""
    out = []

    def one(u):
        try:
            # The BROWSER's Accept header — this endpoint is used as an
            # <img src>, and the answer it gets depends on that.
            req = urllib.request.Request(
                PROXY + urllib.parse.quote(u, safe=""),
                headers={"User-Agent": "Mozilla/5.0",
                         "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"})
            with urllib.request.urlopen(req, timeout=25) as r:
                return (r.status, r.headers.get("X-Proxy-Placeholder"), u)
        except urllib.error.HTTPError as e:
            return (e.code, None, u)
        except Exception as e:
            return ("ERR:" + type(e).__name__, None, u)

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        for res in ex.map(one, urls):
            out.append(res)
            time.sleep(0.45)
    return out


def main():
    print("== the live page: every image-proxy response ==")
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1440, "height": 900})
        pg = ctx.new_page()
        seen = []
        pg.on("response", lambda r: seen.append((r.status, r.url))
              if "/api/image-proxy" in r.url else None)
        errs = []
        pg.on("console", lambda m: errs.append(m.text[:110])
              if m.type == "error" else None)

        pg.goto("https://xyzo.org/", wait_until="domcontentloaded", timeout=90000)
        pg.wait_for_timeout(12000)
        # open a couple of story popups — that is where the images are
        for _ in range(3):
            pg.evaluate(r"""
              () => { const c = document.querySelector('.xyzo-canvas-pins');
                if (!c) return;
                const r = c.getBoundingClientRect();
                const ev = new MouseEvent('click', {bubbles:true, clientX:r.x+r.width/2,
                                                  clientY:r.y+r.height/2});
                c.dispatchEvent(ev); }
            """)
            pg.wait_for_timeout(2500)
        # scroll the live feed
        pg.evaluate("() => { const l=document.getElementById('live-panel-list'); if(l) l.scrollTop = l.scrollHeight; }")
        pg.wait_for_timeout(4000)

        statuses = collections.Counter(s for s, _ in seen)
        print("   image-proxy responses:", len(seen), dict(statuses))
        print("   the bad ones:")
        for s, u in seen:
            if s != 200:
                print("     ", s, u[:140])
        print("   console errors:", errs[:5] or "none")
        ctx.close()
        b.close()

    print("\n== the stored URLs: 400 of the newest articles ==")
    import subprocess
    import os
    api_dir = os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "api")
    script = "/tmp/opencode/_imgs.ts"
    os.makedirs("/tmp/opencode", exist_ok=True)
    with open(script, "w") as fh:
        fh.write(
            'import postgres from "postgres";\n'
            'const sql = postgres(process.env.XYZO_DB_URL || "", { max: 1 });\n'
            'const rows = await sql`SELECT image_url FROM news_articles '
            'WHERE image_url IS NOT NULL AND image_url <> \'\' '
            'ORDER BY published_at DESC NULLS LAST LIMIT 400`;\n'
            'console.log(JSON.stringify(rows.map((r: any) => r.image_url)));\n'
            'await sql.end();\n')
    dest = os.path.join(api_dir, "_imgs_audit_tmp.ts")
    shutil_copy = open(script).read()
    with open(dest, "w") as fh:
        fh.write(shutil_copy)
    try:
        env = dict(os.environ)
        with open(os.path.join(api_dir, ".env")) as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k] = v.strip().strip('"').strip("'")
        out = subprocess.run(["bun", "run", dest], cwd=api_dir, env=env,
                             capture_output=True, text=True, timeout=180)
        urls = json.loads(out.stdout.strip().splitlines()[-1])
    except Exception as e:
        print("   could not read the URLs:", e)
        urls = []

    if urls:
        results = probe(urls)
        statuses = collections.Counter(str(s) for s, _, _ in results)
        dead = [u for s, ph, u in results if ph == "1"]
        print("   probed:", len(results), "statuses:", dict(statuses))
        print("   DEAD at the publisher:", len(dead), "of", len(results))
        hosts = collections.Counter(urllib.parse.urlparse(u).netloc for u in dead)
        print("   the worst hosts:", hosts.most_common(8))
        bad = [(s, u) for s, ph, u in results if str(s) != "200"]
        print("   the non-200 answers (each one is a console error):", len(bad))
        for s, u in bad[:10]:
            print("     ", s, u[:130])


if __name__ == "__main__":
    main()
