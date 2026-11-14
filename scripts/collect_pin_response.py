#!/usr/bin/env python3
from playwright.sync_api import sync_playwright
import sys, time

HASH = sys.argv[1] if len(sys.argv) > 1 else '#20.7561,-17.4023,4/density=max'
URL = f'https://xyzo.org/{HASH}'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    ctx = browser.new_context(ignore_https_errors=True, viewport={'width':1280,'height':800})
    page = ctx.new_page()

    seen = []
    def on_response(resp):
        try:
            if '/api/pins/map' in resp.url:
                t = time.time()
                ok = resp.ok
                st = resp.status
                try:
                    text = resp.text()
                except Exception:
                    text = '<body-unavailable>'
                print('FOUND /api/pins/map ->', resp.url)
                print('  status=', st, 'ok=', ok, 'len=', len(text) if isinstance(text, str) else 'n/a')
                snippet = (text[:800] + '...') if isinstance(text, str) and len(text) > 800 else text
                print('  body (snippet):', snippet)
                seen.append(True)
        except Exception as e:
            print('response handler error', e)

    page.on('response', on_response)

    print('NAV:', URL)
    page.goto(URL, wait_until='networkidle', timeout=20000)

    # Wait up to 30s for pins/map
    deadline = time.time() + 30
    while time.time() < deadline and not seen:
        time.sleep(0.5)

    if not seen:
        print('No /api/pins/map response observed within 30s')

    browser.close()
