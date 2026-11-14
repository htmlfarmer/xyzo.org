#!/usr/bin/env python3
"""
Xyzo Frontend Optimizer

Bundles, minifies, and optimizes frontend assets for faster page loads.

Usage:
  python3 scripts/optimize_frontend.py           # Build optimized assets
  python3 scripts/optimize_frontend.py --analyze  # Analyze without building
  python3 scripts/optimize_frontend.py --watch    # Watch for changes
"""

import argparse
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
PUBLIC = ROOT / "public_html"
DIST = PUBLIC / "dist"

# Files to bundle in order
JS_FILES = [
    "vendor/leaflet/leaflet.js",
    "vendor/leaflet.heat/leaflet-heat.js",
    "vendor/leaflet.markercluster/leaflet.markercluster.js",
    "vendor/marked/marked.umd.min.js",
    "vendor/dompurify/purify.min.js",
    "analytics.js",
    "app.js",
]

CSS_FILES = [
    "vendor/leaflet/leaflet.css",
    "vendor/leaflet.markercluster/MarkerCluster.css",
    "vendor/leaflet.markercluster/MarkerCluster.Default.css",
    "styles.css",
]


def get_file_hash(filepath: Path) -> str:
    """Get MD5 hash of file for cache busting."""
    with open(filepath, 'rb') as f:
        return hashlib.md5(f.read()).hexdigest()[:8]


def minify_js(content: str) -> str:
    """Simple JS minification (remove comments, whitespace)."""
    # Remove single-line comments (but not URLs)
    content = re.sub(r'(?<!:)//(?!www\.|http)[^\n]*', '', content)
    # Remove multi-line comments
    content = re.sub(r'/\*.*?\*/', '', content, flags=re.DOTALL)
    # Collapse whitespace
    content = re.sub(r'\s+', ' ', content)
    # Remove spaces around operators
    content = re.sub(r'\s*([{};:,=+\-*/<>!&|?])\s*', r'\1', content)
    return content.strip()


def minify_css(content: str) -> str:
    """Simple CSS minification."""
    # Remove comments
    content = re.sub(r'/\*.*?\*/', '', content, flags=re.DOTALL)
    # Collapse whitespace
    content = re.sub(r'\s+', ' ', content)
    # Remove spaces around selectors and properties
    content = re.sub(r'\s*([{}:;,])\s*', r'\1', content)
    return content.strip()


def bundle_files(files: list[str], base_dir: Path) -> str:
    """Concatenate files in order."""
    parts = []
    for f in files:
        filepath = base_dir / f
        if filepath.exists():
            with open(filepath, 'r') as fh:
                parts.append(f"/* {f} */\n" + fh.read())
        else:
            print(f"  Warning: {f} not found, skipping")
    return '\n'.join(parts)


def gzip_file(filepath: Path) -> Path:
    """Create gzipped version of file."""
    gz_path = filepath.with_suffix(filepath.suffix + '.gz')
    with open(filepath, 'rb') as f_in:
        with gzip.open(gz_path, 'wb', compresslevel=9) as f_out:
            f_out.write(f_in.read())
    return gz_path


def analyze_sizes():
    """Analyze current file sizes."""
    print("\n=== Frontend Asset Analysis ===\n")

    total_js = 0
    total_css = 0

    print("JavaScript Files:")
    print(f"  {'File':<45} {'Size':>10} {'Gzipped':>10}")
    print("  " + "-" * 67)

    for f in JS_FILES:
        filepath = PUBLIC / f
        if filepath.exists():
            size = filepath.stat().st_size
            total_js += size

            # Estimate gzipped size (roughly 30% for JS)
            gz_est = int(size * 0.3)
            print(f"  {f:<45} {size:>10,} {gz_est:>10,}")

    print(f"  {'TOTAL':<45} {total_js:>10,} {int(total_js * 0.3):>10,}")

    print("\nCSS Files:")
    print(f"  {'File':<45} {'Size':>10} {'Gzipped':>10}")
    print("  " + "-" * 67)

    for f in CSS_FILES:
        filepath = PUBLIC / f
        if filepath.exists():
            size = filepath.stat().st_size
            total_css += size
            gz_est = int(size * 0.25)
            print(f"  {f:<45} {size:>10,} {gz_est:>10,}")

    print(f"  {'TOTAL':<45} {total_css:>10,} {int(total_css * 0.25):>10,}")

    print(f"\nGrand Total: {total_js + total_css:,} bytes ({(total_js + total_css) / 1024:.1f} KB)")
    print(f"Estimated Gzipped: {int((total_js * 0.3) + (total_css * 0.25)):,} bytes")

    # Check for large functions in app.js
    print("\n=== Large Functions in app.js ===\n")
    app_js = PUBLIC / "app.js"
    if app_js.exists():
        with open(app_js) as f:
            content = f.read()

        # Find function definitions and their sizes
        functions = []
        lines = content.split('\n')
        func_start = None
        func_name = None

        for i, line in enumerate(lines):
            match = re.match(r'^(?:async\s+)?function\s+(\w+)', line)
            if match:
                if func_start is not None and func_name:
                    functions.append((func_name, i - func_start))
                func_start = i
                func_name = match.group(1)

        if func_start is not None and func_name:
            functions.append((func_name, len(lines) - func_start))

        functions.sort(key=lambda x: x[1], reverse=True)
        for name, lines_count in functions[:15]:
            print(f"  {name:<40} {lines_count:>5} lines")


def build_optimized():
    """Build optimized frontend assets."""
    print("\n=== Building Optimized Frontend ===\n")

    # Create dist directory
    DIST.mkdir(exist_ok=True)

    # Bundle and minify JS
    print("Bundling JavaScript...")
    js_bundle = bundle_files(JS_FILES, PUBLIC)
    js_minified = minify_js(js_bundle)

    # Write bundle
    js_hash = hashlib.md5(js_minified.encode()).hexdigest()[:8]
    js_filename = f"bundle.{js_hash}.js"
    js_path = DIST / js_filename

    with open(js_path, 'w') as f:
        f.write(js_minified)

    gz_path = gzip_file(js_path)

    print(f"  Created: {js_filename} ({js_path.stat().st_size:,} bytes)")
    print(f"  Gzipped: {gz_path.name} ({gz_path.stat().st_size:,} bytes)")

    # Bundle and minify CSS
    print("\nBundling CSS...")
    css_bundle = bundle_files(CSS_FILES, PUBLIC)
    css_minified = minify_css(css_bundle)

    css_hash = hashlib.md5(css_minified.encode()).hexdigest()[:8]
    css_filename = f"bundle.{css_hash}.css"
    css_path = DIST / css_filename

    with open(css_path, 'w') as f:
        f.write(css_minified)

    gz_path = gzip_file(css_path)

    print(f"  Created: {css_filename} ({css_path.stat().st_size:,} bytes)")
    print(f"  Gzipped: {gz_path.name} ({gz_path.stat().st_size:,} bytes)")

    # Generate manifest
    manifest = {
        "js": js_filename,
        "css": css_filename,
        "js_hash": js_hash,
        "css_hash": css_hash,
        "generated": subprocess.check_output(['date', '-Iseconds']).decode().strip(),
    }

    with open(DIST / 'manifest.json', 'w') as f:
        json.dump(manifest, f, indent=2)

    # Generate optimized index.html
    print("\nGenerating optimized index.html...")
    generate_optimized_html(manifest)

    print("\n=== Build Complete ===")
    print(f"Output: {DIST}")

    # Show savings
    original_size = sum((PUBLIC / f).stat().st_size for f in JS_FILES + CSS_FILES if (PUBLIC / f).exists())
    optimized_size = js_path.stat().st_size + css_path.stat().st_size
    savings = original_size - optimized_size
    print(f"\nOriginal: {original_size:,} bytes ({original_size / 1024:.1f} KB)")
    print(f"Optimized: {optimized_size:,} bytes ({optimized_size / 1024:.1f} KB)")
    print(f"Savings: {savings:,} bytes ({savings / original_size * 100:.1f}%)")


def generate_optimized_html(manifest: dict):
    """Generate optimized index.html with bundled assets."""
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Xyzo — global news map</title>
  <link rel="icon" type="image/svg+xml" href="favicon.svg">
  <link rel="stylesheet" href="dist/{manifest['css']}">
  <!-- Tiles now come from OUR OWN mirror (/api/tile/mirror/…), so a
       preconnect to tile.openstreetmap.org would open a socket nobody
       uses. Nominatim is still hit directly for geocoding. -->
  <link rel="preconnect" href="https://nominatim.openstreetmap.org">
</head>
<body>
  <div id="map" aria-label="world map of news"></div>

  <!-- Live news side panel -->
  <aside id="live-panel" class="live-panel" aria-label="live news panel">
    <button id="live-panel-toggle" class="live-panel-toggle" aria-label="Toggle live news panel" title="Toggle panel">‹</button>
    <header class="live-panel-header">
      <h2>Live news</h2>
      <div class="live-panel-tabs" role="tablist">
        <button type="button" class="live-panel-tab active" data-tab="hot" role="tab" aria-selected="true">Hot</button>
        <button type="button" class="live-panel-tab" data-tab="near" role="tab" aria-selected="false">Near me</button>
      </div>
      <div class="live-panel-meta" id="live-panel-meta">loading…</div>
      <div class="live-panel-loc">
        <input id="live-panel-loc-input" type="text" placeholder="City, address, country…" maxlength="200" autocomplete="off" class="live-panel-loc-input">
        <button type="button" id="live-panel-set-loc" class="live-panel-loc-btn" title="Use your browser's location">📍</button>
        <button type="button" id="live-panel-clear-loc" class="live-panel-loc-btn" title="Clear location">×</button>
      </div>
      <div id="live-panel-loc-results" class="live-panel-loc-results" hidden role="listbox"></div>
    </header>
    <div class="live-panel-body" id="live-panel-body" role="tabpanel">
      <div class="live-panel-list" id="live-panel-list" aria-live="polite"></div>
      <div id="live-panel-wiki" class="live-panel-wiki" hidden></div>
    </div>
  </aside>

  <div id="search-bar">
    <input id="search-input" type="search" placeholder="Search city or news…" maxlength="200" autocomplete="off">
    <button id="search-btn" type="button">Search</button>
    <button id="search-clear" type="button" hidden>Clear</button>
  </div>
  <div id="time-filter" role="group" aria-label="time range">
    <button type="button" data-time="24h" class="active">24h</button>
    <button type="button" data-time="7d">Past Week</button>
    <button type="button" data-time="30d">Past Month</button>
    <button type="button" data-time="365d">Past Year</button>
    <button type="button" data-time="custom" id="time-custom-btn" aria-haspopup="dialog" aria-expanded="false">Custom…</button>
    <button type="button" data-time="all">All Time</button>
  </div>
  <div id="time-custom-popover" class="time-custom-popover" hidden role="dialog" aria-label="Custom time range">
    <label for="time-custom-input">Past <strong id="time-custom-label">7</strong>&nbsp;days</label>
    <div class="time-custom-controls">
      <button type="button" data-delta="-1" aria-label="One day fewer">−</button>
      <input id="time-custom-input" type="number" min="1" max="90" step="1" value="7" inputmode="numeric">
      <button type="button" data-delta="1" aria-label="One day more">+</button>
    </div>
    <p class="time-custom-hint">1–90 days. Picks current activity inside that window.</p>
    <div class="time-custom-actions">
      <button type="button" id="time-custom-cancel">Cancel</button>
      <button type="button" id="time-custom-apply" class="primary">Apply</button>
    </div>
  </div>
  <div id="mode-toggle" role="group" aria-label="render mode">
    <button type="button" data-mode="markers" class="active">Markers</button>
    <button type="button" data-mode="heatmap">Heatmap</button>
    <button type="button" data-mode="clusters">Clusters</button>
    <button type="button" id="links-toggle" class="links-toggle" aria-pressed="false" aria-label="Toggle story connections">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      <span>Links</span>
    </button>
    <button type="button" id="explore-region-btn" class="explore-btn" aria-label="Explore region for news sources" title="Discover news sources in this area">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="m11 8v6"/><path d="m8 11h6"/></svg>
      <span>Explore</span>
    </button>
  </div>

  <div id="links-legend" class="links-legend" hidden aria-hidden="true">
    <div class="links-legend-row"><span class="links-swatch" style="background:#5eead4"></span>shared source</div>
    <div class="links-legend-row"><span class="links-swatch" style="background:#f59e0b"></span>shared location</div>
    <div class="links-legend-row"><span class="links-swatch" style="background:#e879f9"></span>shared entity</div>
    <div class="links-legend-row"><span class="links-swatch" style="background:#60a5fa"></span>shared topic</div>
  </div>
  <details id="legend" class="legend">
    <summary class="legend-toggle" aria-label="Toggle icon legend">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>
      Legend
    </summary>
    <div class="legend-body" id="legend-body"></div>
  </details>
  <p id="search-status" aria-live="polite"></p>
  <button id="live-panel-reopen" class="live-panel-reopen" aria-label="Show live news panel">Live news ›</button>
  <button id="submit-btn" type="submit-btn" aria-label="submit news">Submit News</button>
  <div id="nav-links" class="nav-links">
    <a href="/requests.html" title="View community requests">Requests</a>
    <a href="/system.html" title="System logs">System</a>
    <a href="/rankings.html" title="Source rankings">Rankings</a>
  </div>
  <div id="submitter-overlay" hidden>
    <div class="overlay-card">
      <button type="button" id="card-close-btn" aria-label="Close submit form" title="Close">×</button>
      <h2>Submit News</h2>
      <form id="submit-form">
        <label>Title <input name="title" maxlength="200" required></label>
        <label>Your Name <input name="submitter_name" maxlength="100" required></label>
        <label>Email <input name="submitter_email" type="email" maxlength="254" required></label>
        <label>URL (optional) <input name="canonical_url" type="url"></label>
        <label>Category
          <select name="category">
            <option value="">—</option>
            <option>politics</option><option>business</option><option>crime</option>
            <option>weather</option><option>science</option><option>technology</option>
            <option>sports</option><option>culture</option><option>environment</option>
            <option>conflict</option><option>health</option><option>other</option>
          </select>
        </label>
        <input name="hp_company" type="text" tabindex="-1" autocomplete="off"
               style="position:absolute;left:-9999px" aria-hidden="true">
        <label>Place name
          <div class="place-row">
            <input name="place" id="place-input" placeholder="e.g. Karachi, Pakistan" maxlength="500" autocomplete="off">
            <button type="button" id="find-btn">Find</button>
          </div>
        </label>
        <p id="place-status" class="coord-display" aria-live="polite"></p>
        <div id="mini-map" aria-label="click to set location"></div>
        <p class="coord-display">lat: <span id="lat-display">—</span> lng: <span id="lng-display">—</span></p>
        <div class="overlay-actions">
          <button type="button" id="cancel-btn">Cancel</button>
          <button type="submit" id="confirm-btn">Submit</button>
        </div>
      </form>
    </div>
  </div>
  <div id="explore-panel" class="explore-panel" hidden>
    <div class="explore-panel-header">
      <h3>Explore Region</h3>
      <button type="button" id="explore-close" class="explore-close" aria-label="Close explore panel">×</button>
    </div>
    <div class="explore-panel-body" id="explore-panel-body">
      <p class="explore-hint">Zoom to a region and click "Explore" to discover news sources and existing coverage.</p>
      <div id="explore-results" class="explore-results" hidden></div>
      <div id="explore-status" class="explore-status" hidden></div>
      <div class="explore-actions">
        <button type="button" id="explore-start" class="explore-start-btn">Explore This Region</button>
        <label class="explore-auto-add">
          <input type="checkbox" id="explore-auto-add"> Auto-add validated sources
        </label>
      </div>
    </div>
  </div>
  <script src="dist/{manifest['js']}"></script>
</body>
</html>"""

    with open(DIST / 'index.html', 'w') as f:
        f.write(html)


def main():
    parser = argparse.ArgumentParser(description="Frontend optimizer")
    parser.add_argument("--analyze", action="store_true", help="Analyze without building")
    parser.add_argument("--build", action="store_true", help="Build optimized assets")
    args = parser.parse_args()

    if args.analyze:
        analyze_sizes()
    else:
        build_optimized()


if __name__ == "__main__":
    main()
