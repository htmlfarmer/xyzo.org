#!/usr/bin/env python3
from playwright.sync_api import sync_playwright
import sys

HASH = sys.argv[1] if len(sys.argv) > 1 else '#12.8546,-34.7168,4/time=30d/density=max'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(ignore_https_errors=True, viewport={"width":1280,"height":800})
    page = ctx.new_page()
    page.goto(f'https://xyzo.org/{HASH}', wait_until='networkidle', timeout=15000)
    # Give app some time to run initialization
    page.wait_for_timeout(1200)

    def el_text(sel):
        try:
            t = page.text_content(sel)
            return t.strip() if t else ''
        except Exception:
            return ''

    parsed = page.evaluate('''() => {
        try { return window.parseMapHash ? parseMapHash(window.location.hash) : null; } catch (e) { return {error: String(e)} }
    }''')
    tf = page.evaluate('() => (typeof window.timeFilter !== "undefined" ? window.timeFilter : null)')
    pd = page.evaluate('() => (typeof window.pinDensity !== "undefined" ? window.pinDensity : null)')
    print('location.hash=', page.evaluate('() => location.hash'))
    print('parseMapHash ->', parsed)
    print('timeFilter ->', tf)
    print('pinDensity ->', pd)
    print('#time-dropdown-label ->', el_text('#time-dropdown-label'))
    print('#density-dropdown-label ->', el_text('#density-dropdown-label'))

    browser.close()
