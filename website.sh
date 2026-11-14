#!/usr/bin/env bash
# website.sh — XYZO Production-Grade Audit Engine
# Runs a comprehensive diagnostic against a live XYZO deployment.
#
# Usage:
#   ./website.sh https://xyzo.org              # quick audit (5 layers)
#   ./website.sh https://xyzo.org --full        # full audit (all layers)
#   ./website.sh https://xyzo.org --report-dir /tmp/audit  # custom output
#
set -euo pipefail

URL="${1:-https://xyzo.org}"
FULL="${2:-}"
REPORT_DIR="${3:-/tmp/xyzo-audit-$(date +%Y%m%d-%H%M%S)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$REPORT_DIR"/{screenshots,traces,db}

echo "════════════════════════════════════════════════════════════"
echo "  XYZO WEBSITE DIAGNOSTIC ENGINE"
echo "  Target: $URL"
echo "  Report: $REPORT_DIR"
echo "  Mode: ${FULL:---quick}"
echo "════════════════════════════════════════════════════════════"
echo ""

# ── Layer 1: DNS + TLS + HTTP Headers ──────────────────────────────────
echo "[1/9] DNS + TLS + Headers..."
python3 -c "
import json, ssl, socket, urllib.request, time
from urllib.parse import urlparse

url = '$URL'
parsed = urlparse(url)
host = parsed.hostname
port = parsed.port or (443 if parsed.scheme == 'https' else 80)

# DNS
t0 = time.monotonic()
try:
    addrs = socket.getaddrinfo(host, port)
    dns_ms = (time.monotonic() - t0) * 1000
    ip = addrs[0][4][0]
except Exception as e:
    dns_ms = -1
    ip = str(e)

# TLS
tls_ms = -1
cert_info = {}
if parsed.scheme == 'https':
    try:
        ctx = ssl.create_default_context()
        t0 = time.monotonic()
        with ctx.wrap_socket(socket.socket(), server_hostname=host) as s:
            s.settimeout(10)
            s.connect((host, port))
            cert = s.getpeercert()
            tls_ms = (time.monotonic() - t0) * 1000
            cert_info = {
                'subject': dict(x[0] for x in cert.get('subject', [])),
                'issuer': dict(x[0] for x in cert.get('issuer', [])),
                'notAfter': cert.get('notAfter', ''),
                'sans': [e[1] for e in cert.get('subjectAltName', [])],
            }
    except Exception as e:
        tls_ms = -1
        cert_info = {'error': str(e)}

# HTTP headers
headers = {}
t0 = time.monotonic()
try:
    req = urllib.request.Request(url, method='HEAD')
    req.add_header('User-Agent', 'XYZO-Audit/1.0')
    with urllib.request.urlopen(req, timeout=10) as resp:
        http_ms = (time.monotonic() - t0) * 1000
        headers = dict(resp.headers)
        status = resp.status
except Exception as e:
    http_ms = -1
    headers = {'error': str(e)}
    status = 0

result = {
    'dns': {'host': host, 'ip': ip, 'ms': round(dns_ms, 1)},
    'tls': {'ms': round(tls_ms, 1), 'cert': cert_info},
    'http': {'status': status, 'ms': round(http_ms, 1), 'headers': headers},
}
print(json.dumps(result, indent=2))
" > "$REPORT_DIR/01-dns-tls-headers.json" 2>&1
echo "  ✓ DNS/TLS/Headers saved"

# ── Layer 2: HTML + Resources ──────────────────────────────────────────
echo "[2/9] HTML + Resources..."
python3 -c "
import json, urllib.request, re, time

url = '$URL'
t0 = time.monotonic()
req = urllib.request.Request(url)
req.add_header('User-Agent', 'XYZO-Audit/1.0')
with urllib.request.urlopen(req, timeout=15) as resp:
    html = resp.read()
    load_ms = (time.monotonic() - t0) * 1000
    content_type = resp.headers.get('Content-Type', '')

# Find all linked resources
css_urls = re.findall(r'href=[\"\\x27]([^\"\\x27]*\\.css)', html.decode('utf-8', errors='replace'))
js_urls = re.findall(r'src=[\"\\x27]([^\"\\x27]*\\.js)', html.decode('utf-8', errors='replace'))
img_urls = re.findall(r'<img[^>]+src=[\"\\x27]([^\"\\x27]+)', html.decode('utf-8', errors='replace'))

# Resolve relative URLs
from urllib.parse import urljoin
css_urls = [urljoin(url, u) for u in css_urls]
js_urls = [urljoin(url, u) for u in js_urls]

result = {
    'html_size_bytes': len(html),
    'html_size_kb': round(len(html) / 1024, 1),
    'load_ms': round(load_ms, 1),
    'content_type': content_type,
    'css_count': len(css_urls),
    'js_count': len(js_urls),
    'img_count': len(img_urls),
    'css_urls': css_urls[:10],
    'js_urls': js_urls[:10],
}
print(json.dumps(result, indent=2))
" > "$REPORT_DIR/02-html-resources.json" 2>&1
echo "  ✓ HTML/Resources saved"

# ── Layer 3: Browser Automation + UI Test ──────────────────────────────
echo "[3/9] Browser + UI Test (Playwright)..."
python3 -m worker.xyzo_audit.browser_test "$URL" "$REPORT_DIR" 2>&1 | tail -5
echo "  ✓ Browser test saved"

# ── Layer 4: Network Inspection ────────────────────────────────────────
echo "[4/9] Network Inspection..."
python3 -m worker.xyzo_audit.network_inspector "$URL" "$REPORT_DIR" 2>&1 | tail -5
echo "  ✓ Network inspection saved"

# ── Layer 5: Core Web Vitals ───────────────────────────────────────────
echo "[5/9] Core Web Vitals..."
python3 -m worker.xyzo_audit.page_speed "$URL" "$REPORT_DIR" 2>&1 | tail -5
echo "  ✓ Web Vitals saved"

# ── Layer 6: Mobile Matrix ────────────────────────────────────────────
echo "[6/9] Mobile Matrix..."
python3 -m worker.xyzo_audit.mobile_matrix "$URL" "$REPORT_DIR" 2>&1 | tail -5
echo "  ✓ Mobile matrix saved"

# ── Layer 7: PostgreSQL Profile ────────────────────────────────────────
echo "[7/9] PostgreSQL Profile..."
python3 -m worker.xyzo_audit.db_profiler "$REPORT_DIR" 2>&1 | tail -5
echo "  ✓ DB profile saved"

if [ "$FULL" = "--full" ]; then
    # ── Layer 8: Security Audit ────────────────────────────────────────
    echo "[8/9] Security Audit..."
    python3 -c "
import json, urllib.request

url = '$URL'
req = urllib.request.Request(url, method='HEAD')
req.add_header('User-Agent', 'XYZO-Audit/1.0')
with urllib.request.urlopen(req, timeout=10) as resp:
    h = dict(resp.headers)

security = {
    'headers': {
        'strict-transport-security': h.get('Strict-Transport-Security', 'MISSING'),
        'content-security-policy': h.get('Content-Security-Policy', 'MISSING'),
        'x-content-type-options': h.get('X-Content-Type-Options', 'MISSING'),
        'x-frame-options': h.get('X-Frame-Options', 'MISSING'),
        'x-xss-protection': h.get('X-XSS-Protection', 'MISSING'),
        'referrer-policy': h.get('Referrer-Policy', 'MISSING'),
        'permissions-policy': h.get('Permissions-Policy', 'MISSING'),
        'cross-origin-resource-policy': h.get('Cross-Origin-Resource-Policy', 'MISSING'),
    },
    'score': 0,
}
total = len(security['headers'])
for v in security['headers'].values():
    if v != 'MISSING':
        security['score'] += 1
security['score_pct'] = round(security['score'] / total * 100)

print(json.dumps(security, indent=2))
" > "$REPORT_DIR/08-security.json" 2>&1
    echo "  ✓ Security saved"

    # ── Layer 9: Lighthouse ────────────────────────────────────────────
    echo "[9/9] Lighthouse..."
    if command -v lighthouse &>/dev/null; then
        lighthouse "$URL" --output=json --output-path="$REPORT_DIR/09-lighthouse.json" \
            --chrome-flags="--headless --no-sandbox" --quiet 2>/dev/null || echo "  ⚠ Lighthouse failed"
    else
        echo '{"error": "lighthouse not installed"}' > "$REPORT_DIR/09-lighthouse.json"
        echo "  ⚠ Lighthouse not installed, skipping"
    fi
else
    echo "[8/9] Skipped (use --full for security + lighthouse)"
    echo "[9/9] Skipped (use --full for security + lighthouse)"
fi

# ── Generate Report ────────────────────────────────────────────────────
echo ""
echo "Generating report..."
python3 -m worker.xyzo_audit.report "$REPORT_DIR" 2>&1

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  AUDIT COMPLETE"
echo "  Report: $REPORT_DIR/report.html"
echo "  Data:   $REPORT_DIR/report.json"
echo "════════════════════════════════════════════════════════════"
