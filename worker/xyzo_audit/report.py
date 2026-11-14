"""Report generator — consolidates all audit data into JSON + HTML.

Usage:
    python -m worker.xyzo_audit.report /tmp/xyzo-audit
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from datetime import datetime


def load_json(path: Path) -> dict:
    """Load a JSON file, return empty dict on failure."""
    if not path.exists():
        return {"error": f"file not found: {path.name}"}
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        return {"error": str(e)}


def generate_html_report(data: dict, report_dir: Path) -> str:
    """Generate an HTML report from consolidated JSON data."""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Extract key metrics
    dns = data.get("dns_tls", {}).get("dns", {})
    tls = data.get("dns_tls", {}).get("tls", {})
    html_res = data.get("html_resources", {})
    vitals = data.get("page_speed", {}).get("vitals", {})
    network = data.get("network", {})
    browser = data.get("browser_test", {})
    mobile = data.get("mobile_matrix", {})
    db = data.get("db_profile", {})
    security = data.get("security", {})

    # Build flags summary
    all_flags = []
    for section, sdata in data.items():
        if isinstance(sdata, dict) and "flags" in sdata:
            for flag in sdata["flags"]:
                if isinstance(flag, str):
                    all_flags.append({"section": section, "flag": flag})
                elif isinstance(flag, dict):
                    all_flags.append({"section": section, "flag": flag.get("flag", str(flag))})

    critical_flags = [f for f in all_flags if any(k in f["flag"] for k in ["CRITICAL", "FAILED", "ERROR", "SLOW"])]

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>XYZO Audit Report — {ts}</title>
<style>
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 20px; line-height: 1.6; }}
h1 {{ color: #ff6b35; margin-bottom: 8px; font-size: 28px; }}
h2 {{ color: #ff9f1c; margin: 24px 0 12px; font-size: 20px; border-bottom: 1px solid #333; padding-bottom: 6px; }}
h3 {{ color: #2ec4b6; margin: 16px 0 8px; font-size: 16px; }}
.subtitle {{ color: #888; margin-bottom: 24px; }}
.grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin: 12px 0; }}
.metric {{ background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 16px; text-align: center; }}
.metric .value {{ font-size: 32px; font-weight: bold; color: #fff; }}
.metric .label {{ font-size: 12px; color: #888; text-transform: uppercase; }}
.metric.good .value {{ color: #2ec4b6; }}
.metric.warn .value {{ color: #ff9f1c; }}
.metric.bad .value {{ color: #e63946; }}
table {{ width: 100%; border-collapse: collapse; margin: 12px 0; }}
th, td {{ padding: 8px 12px; text-align: left; border-bottom: 1px solid #333; font-size: 13px; }}
th {{ background: #1a1a1a; color: #ff9f1c; font-weight: 600; }}
tr:hover {{ background: #1a1a1a; }}
.flag {{ display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; margin: 2px; }}
.flag.critical {{ background: #e63946; color: #fff; }}
.flag.warning {{ background: #ff9f1c; color: #000; }}
.flag.info {{ background: #2ec4b6; color: #000; }}
.pass {{ color: #2ec4b6; }} .fail {{ color: #e63946; }} .warn {{ color: #ff9f1c; }}
.screenshot {{ max-width: 100%; border: 1px solid #333; border-radius: 8px; margin: 8px 0; }}
</style>
</head>
<body>
<h1>XYZO Audit Report</h1>
<div class="subtitle">Generated: {ts} | Target: {data.get('url', 'unknown')}</div>

<h2>Performance Summary</h2>
<div class="grid">
  <div class="metric {'good' if dns.get('ms', 999) < 50 else 'warn' if dns.get('ms', 999) < 200 else 'bad'}">
    <div class="value">{dns.get('ms', '?')}ms</div><div class="label">DNS</div>
  </div>
  <div class="metric {'good' if tls.get('ms', 999) < 100 else 'warn' if tls.get('ms', 999) < 300 else 'bad'}">
    <div class="value">{tls.get('ms', '?')}ms</div><div class="label">TLS</div>
  </div>
  <div class="metric {'good' if vitals.get('ttfb_ms', 999) < 200 else 'warn' if vitals.get('ttfb_ms', 999) < 600 else 'bad'}">
    <div class="value">{vitals.get('ttfb_ms', '?')}ms</div><div class="label">TTFB</div>
  </div>
  <div class="metric {'good' if vitals.get('fcp_ms', 9999) < 1800 else 'warn' if vitals.get('fcp_ms', 9999) < 3000 else 'bad'}">
    <div class="value">{round(vitals.get('fcp_ms', 0)/1000, 1)}s</div><div class="label">FCP</div>
  </div>
  <div class="metric {'good' if vitals.get('lcp_ms', 9999) < 2500 else 'warn' if vitals.get('lcp_ms', 9999) < 4000 else 'bad'}">
    <div class="value">{round(vitals.get('lcp_ms', 0)/1000, 1)}s</div><div class="label">LCP</div>
  </div>
  <div class="metric {'good' if network.get('failed_requests', 99) == 0 else 'bad'}">
    <div class="value">{network.get('failed_requests', '?')}</div><div class="label">Failed Requests</div>
  </div>
  <div class="metric {'good' if network.get('slow_requests', 99) == 0 else 'warn' if network.get('slow_requests', 99) < 5 else 'bad'}">
    <div class="value">{network.get('slow_requests', '?')}</div><div class="label">Slow Requests</div>
  </div>
  <div class="metric">
    <div class="value">{round(vitals.get('transfer_size', 0)/1024, 0) if vitals.get('transfer_size') else network.get('total_bytes', 0) // 1024}KB</div><div class="label">Transfer</div>
  </div>
</div>

<h2>Critical Flags ({len(critical_flags)})</h2>
"""
    if critical_flags:
        html += "<table><tr><th>Section</th><th>Flag</th></tr>"
        for f in critical_flags:
            cls = "critical" if "CRITICAL" in f["flag"] or "FAILED" in f["flag"] else "warning"
            html += f'<tr><td>{f["section"]}</td><td><span class="flag {cls}">{f["flag"]}</span></td></tr>'
        html += "</table>"
    else:
        html += '<p class="pass">No critical flags detected.</p>'

    # Network breakdown
    if network.get("by_type"):
        html += "<h2>Network by Type</h2><table><tr><th>Type</th><th>Count</th><th>Bytes</th><th>ms</th></tr>"
        for rtype, stats in sorted(network["by_type"].items(), key=lambda x: -x[1].get("bytes", 0)):
            html += f'<tr><td>{rtype}</td><td>{stats["count"]}</td><td>{stats["bytes"]//1024}KB</td><td>{stats["ms"]:.0f}ms</td></tr>'
        html += "</table>"

    # DB profiles
    if db.get("profiles"):
        html += "<h2>Database Query Profiles</h2><table><tr><th>Query</th><th>Time</th><th>Rows</th><th>Seq Scans</th><th>Flags</th></tr>"
        for p in db["profiles"]:
            flags_str = " ".join(f'<span class="flag warning">{f}</span>' for f in p.get("flags", []))
            cls = "pass" if not p.get("flags") else "fail"
            html += f'<tr><td>{p["name"]}</td><td class="{cls}">{p["total_ms"]}ms</td><td>{p["rows_returned"]}</td><td>{p.get("seq_scans", 0)}</td><td>{flags_str}</td></tr>'
        html += "</table>"

    # Table stats
    if db.get("table_stats"):
        html += "<h2>Table Sizes</h2><table><tr><th>Metric</th><th>Value</th></tr>"
        for k, v in db["table_stats"].items():
            html += f"<tr><td>{k}</td><td>{v}</td></tr>"
        html += "</table>"

    # Security
    if security.get("headers"):
        html += "<h2>Security Headers</h2><table><tr><th>Header</th><th>Status</th></tr>"
        for h, v in security["headers"].items():
            cls = "pass" if v != "MISSING" else "fail"
            html += f'<tr><td>{h}</td><td class="{cls}">{v[:60]}</td></tr>'
        html += f'<tr><td><b>Score</b></td><td><b>{security.get("score_pct", 0)}%</b></td></tr>'
        html += "</table>"

    # Browser test
    if browser.get("click_results"):
        failures = [r for r in browser["click_results"] if not r.get("success")]
        html += f"<h2>UI Test Results</h2>"
        html += f"<p>Elements found: {browser.get('elements_found', 0)} | Clicked: {browser.get('elements_clicked', 0)} | <span class='fail'>Failed: {len(failures)}</span></p>"
        if failures:
            html += "<table><tr><th>Element</th><th>Selector</th><th>Error</th></tr>"
            for f in failures:
                html += f'<tr><td>{f.get("element", "?")[:40]}</td><td><code>{f.get("selector", "?")}</code></td><td class="fail">{f.get("error", "?")}</td></tr>'
            html += "</table>"

    # Console errors
    if browser.get("console_errors"):
        html += f"<h2>Console Errors ({len(browser['console_errors'])})</h2><table><tr><th>Error</th></tr>"
        for e in browser["console_errors"][:20]:
            html += f"<tr><td class='fail'>{e[:120]}</td></tr>"
        html += "</table>"

    html += """
<h2>Screenshots</h2>
<div style="display: flex; flex-wrap: wrap; gap: 8px;">
"""
    screenshots_dir = report_dir / "screenshots"
    if screenshots_dir.exists():
        for img in sorted(screenshots_dir.glob("*.png")):
            html += f'<img src="screenshots/{img.name}" class="screenshot" alt="{img.stem}" loading="lazy" style="max-width: 400px;">'

    html += """
</div>
<div style="margin-top: 40px; padding: 20px; border-top: 1px solid #333; color: #666; font-size: 12px;">
  Generated by XYZO Audit Engine | <a href="https://xyzo.org" style="color: #ff6b35;">xyzo.org</a>
</div>
</body></html>"""

    return html


def generate_report(report_dir: str):
    """Consolidate all audit data into final report."""
    rd = Path(report_dir)

    # Load all audit data
    data = {
        "url": "",
        "dns_tls": load_json(rd / "01-dns-tls-headers.json"),
        "html_resources": load_json(rd / "02-html-resources.json"),
        "browser_test": load_json(rd / "03-browser-test.json"),
        "network": load_json(rd / "04-network.json"),
        "page_speed": load_json(rd / "05-page-speed.json"),
        "mobile_matrix": load_json(rd / "06-mobile-matrix.json"),
        "db_profile": load_json(rd / "07-db-profile.json"),
        "security": load_json(rd / "08-security.json"),
    }

    # Extract URL
    data["url"] = (
        data.get("dns_tls", {}).get("dns", {}).get("host", "")
        or data.get("page_speed", {}).get("url", "")
        or "unknown"
    )

    # Save consolidated JSON
    with open(rd / "report.json", "w") as f:
        json.dump(data, f, indent=2, default=str)

    # Generate HTML
    html = generate_html_report(data, rd)
    with open(rd / "report.html", "w") as f:
        f.write(html)

    print(f"  Report saved: {rd / 'report.html'}")
    print(f"  Data saved: {rd / 'report.json'}")


def main():
    report_dir = sys.argv[1] if len(sys.argv) > 1 else "/tmp/xyzo-audit"
    generate_report(report_dir)


if __name__ == "__main__":
    main()
