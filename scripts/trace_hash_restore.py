#!/usr/bin/env python3
from playwright.sync_api import sync_playwright
import sys, time, json

HASH = sys.argv[1] if len(sys.argv) > 1 else '#20.7561,-17.4023,4/density=max'
URL = f'https://xyzo.org/{HASH}'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    ctx = browser.new_context(ignore_https_errors=True, viewport={'width':1280,'height':800})
    page = ctx.new_page()

    logs = []
    def on_console(msg):
        try:
            logs.append({'type':'console', 'text': msg.text(), 'location': msg.location()})
            print('CONSOLE:', msg.type, msg.text())
        except Exception:
            print('CONSOLE: <error reading message>')

    def on_request_failed(req):
        print('REQUEST FAILED:', req.url, req.failure)
        logs.append({'type':'requestfailed', 'url': req.url, 'failure': req.failure})

    def on_response(resp):
        try:
            if '/api/pins/map' in resp.url:
                text = None
                try:
                    text = resp.text()
                except Exception:
                    text = '<body-unavailable>'
                print('FOUND /api/pins/map ->', resp.url)
                print('  status=', resp.status, 'ok=', resp.ok, 'len=', len(text) if isinstance(text, str) else 'n/a')
                snippet = (text[:800] + '...') if isinstance(text, str) and len(text) > 800 else text
                print('  body (snippet):', snippet)
                logs.append({'type':'response','url':resp.url,'status':resp.status,'ok':resp.ok,'body_snippet':snippet})
        except Exception as e:
            print('response handler error', e)

    page.on('console', on_console)
    page.on('requestfailed', on_request_failed)
    page.on('response', on_response)

    print('NAV:', URL)
    page.goto(URL, wait_until='networkidle', timeout=20000)
    # Let app initialize further
    page.wait_for_timeout(2000)

    # Capture DOM and labels
    try:
        parsed = page.evaluate('() => (window.parseMapHash ? parseMapHash(window.location.hash) : null)')
    except Exception as e:
        parsed = {'error': str(e)}
    try:
        tf = page.evaluate('() => (typeof window.timeFilter !== "undefined" ? window.timeFilter : null)')
    except Exception as e:
        tf = {'error': str(e)}
    try:
        pd = page.evaluate('() => (typeof window.pinDensity !== "undefined" ? window.pinDensity : null)')
    except Exception as e:
        pd = {'error': str(e)}

    print('location.hash=', page.evaluate('() => location.hash'))
    print('parseMapHash ->', json.dumps(parsed))
    print('timeFilter ->', tf)
    print('pinDensity ->', pd)
    try:
        tlabel = page.text_content('#time-dropdown-label') or ''
    except Exception:
        tlabel = ''
    try:
        dlabel = page.text_content('#density-dropdown-label') or ''
    except Exception:
        dlabel = ''
    print('#time-dropdown-label ->', tlabel.strip())
    print('#density-dropdown-label ->', dlabel.strip())

    # Save a screenshot and HTML to disk for inspection
    screenshot = f'/tmp/xyzo_trace_{int(time.time())}.png'
    htmlfile = f'/tmp/xyzo_trace_{int(time.time())}.html'
    page.screenshot(path=screenshot, full_page=True)
    with open(htmlfile, 'w') as f:
        f.write(page.content())
    print('Saved screenshot to', screenshot)
    print('Saved page HTML to', htmlfile)

    browser.close()
