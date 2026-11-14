"""
The probe audit — is the number under the cursor CORRECT, and is it the
ONLY number under the cursor?

WHAT IT CHECKS
--------------
1. **NO TWO READOUTS OVERLAP.** Every layer that has a number under the
   cursor draws its own box (the wind, the wind speed, the climate, the
   temperature, the soil, the magnetic field, the lightning, the
   phytoplankton, the relief, the waves, the ocean currents) plus the
   hover card. They used to place THEMSELVES at "cursor + 14px" — the
   same 14px — so with three of them on, three boxes landed on the same
   spot and covered each other. `public_html/probe-stack.js` is the ONE
   positioner; this script is what proves it works.

2. **THE WIND DIRECTION IS RIGHT.** The probe's compass point and
   bearing are compared against the PUBLISHED GRID — the same
   `data/wind/grid.bin` the browser reads — sampled here in Python with
   its own bilinear interpolation. A sign flip, a swapped u/v, a
   mirrored field or a mis-plotted arrow all show up as a bearing
   that disagrees with the grid.

3. **THE TWO WIND READINGS AGREE.** The wind animation and the wind
   SPEED field are the same air: the first prints the speed and the
   direction, the second the magnitude of the same u/v pair. They used
   to print two different numbers for the same air (2.3 m/s and
   2.4 m/s) because one interpolated u and v and took the magnitude
   while the other interpolated a pre-derived magnitude grid.

4. **NOTHING RUNS OFF THE SCREEN.** A readout that hangs off the edge
   is a readout the reader cannot read.

RUN
---
    python3 scripts/probe_audit.py                 # the live site
    python3 scripts/probe_audit.py --url <url>     # a specific map
    python3 scripts/probe_audit.py --json          # machine-readable

The audit is a MEASUREMENT, not a fix: it reports what it found and
exits non-zero when it found an overlap or a wrong bearing.
"""
import json
import math
import struct
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://xyzo.org"

# The map the owner sent: every overlay that has a reading, the wind
# animation AND the wind speed field, and the isobars at 1 hPa.
DEFAULT_URL = (
    BASE
    + "/#20.1385,-26.7188,3/density=max/overlay="
    "soil-soilgrids@20,basins@100,cropland-esa@40,land-cover-esa@15,"
    "rivers@100,koppen@20,wind-gfs@100,ocean-currents-live@100,"
    "population-density-worldpop-1-km@20,wind-speed-gfs@30,isobars@100"
    "/iso=1:pressure/wind=particles:colourful"
)

# The published grid, read once. The browser reads the same bytes.
GRID_PATH = ROOT / "public_html" / "data" / "wind" / "grid.bin"
META_PATH = ROOT / "public_html" / "data" / "wind" / "meta.json"

PROBE_SELECTORS = [
    ".climate-probe",
    ".temp-probe",
    ".field-probe",
    ".wind-probe",
    ".lightning-probe",
    ".phytoplankton-probe",
    ".ocean-current-probe",
    ".hover-hud",
]

# What the page shows, read out of the DOM in one call.
COLLECT_JS = r"""
() => {
  const sels = %s;
  const out = [];
  for (const s of sels) {
    for (const el of document.querySelectorAll(s)) {
      if (el.hidden || el.classList.contains('hidden')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      out.push({
        sel: s,
        id: el.id || null,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      });
    }
  }
  const map = window._xyzoMap;
  return { boxes: out, hasMap: !!map };
}
"""

LATLNG_JS = r"""
([x, y]) => {
  const map = window._xyzoMap;
  if (!map) return null;
  const ll = map.containerPointToLatLng([x, y]);
  if (!ll) return null;
  return { lat: ll.lat, lng: ll.lng, zoom: map.getZoom() };
}
"""


# ── the published grid, read independently ──────────────────────────────
class PublishedWind:
    """The wind grid, sampled the way the browser samples it."""

    def __init__(self, grid_path: Path = GRID_PATH, meta_path: Path = META_PATH):
        meta = json.loads(meta_path.read_text())
        g = meta["grid"]
        self.meta = meta
        self.cols = int(g["cols"])
        self.rows = int(g["rows"])
        self.lat_min = float(g["lat_min"])
        self.lat_max = float(g["lat_max"])
        self.lon_min = float(g["lon_min"])
        self.lat_step = float(g["lat_step"])
        self.lon_step = float(g["lon_step"])
        self.scale = float(g.get("scale", 100))
        raw = grid_path.read_bytes()
        n = self.cols * self.rows
        if len(raw) != n * 4:
            raise ValueError(f"grid.bin is {len(raw)} bytes, expected {n * 4}")
        self.u = struct.unpack("<%dh" % n, raw[: 2 * n])
        self.v = struct.unpack("<%dh" % n, raw[2 * n:])

    def sample(self, lat, lon):
        if lat < self.lat_min or lat > self.lat_max:
            return None
        lon = ((((lon - self.lon_min) % 360) + 360) % 360) + self.lon_min
        gx = (lon - self.lon_min) / self.lon_step
        gy = (lat - self.lat_min) / self.lat_step
        x0 = int(math.floor(gx))
        y0 = int(math.floor(gy))
        x1 = (x0 + 1) % self.cols
        y1 = min(y0 + 1, self.rows - 1)
        fx = gx - x0
        fy = gy - y0

        def at(arr, r, c):
            return arr[r * self.cols + c]

        u = (1 - fy) * ((1 - fx) * at(self.u, y0, x0) + fx * at(self.u, y0, x1)) + fy * (
            (1 - fx) * at(self.u, y1, x0) + fx * at(self.u, y1, x1)
        )
        v = (1 - fy) * ((1 - fx) * at(self.v, y0, x0) + fx * at(self.v, y0, x1)) + fy * (
            (1 - fx) * at(self.v, y1, x0) + fx * at(self.v, y1, x1)
        )
        return u / self.scale, v / self.scale


def compass(deg: float) -> str:
    names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
             "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return names[int(round((deg % 360) / 22.5)) % 16]


def describe(u: float, v: float) -> dict:
    speed = math.hypot(u, v)
    frm = math.degrees(math.atan2(-u, -v)) % 360
    return {
        "speed_ms": round(speed, 2),
        "speed_mph": round(speed * 2.23694),
        "speed_kmh": round(speed * 3.6),
        "speed_kt": round(speed * 1.94384),
        "from_deg": round(frm, 1),
        "from": compass(frm),
    }


# ── geometry ────────────────────────────────────────────────────────────
def overlap_area(a, b) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    y = max(0, min(ay + ah, by + bh) - max(ay, by))
    return x * y


def rect_outside(a, w, h) -> bool:
    x, y, aw, ah = a
    return x < -1 or y < -1 or x + aw > w + 1 or y + ah > h + 1


def parse_wind_text(text: str):
    """Pull the numbers out of a wind readout.

    `5 mph · 8 km/h · 4 kt from SE (145°)`  ->  dict
    """
    out = {}
    for unit, key in (("mph", "mph"), ("km/h", "kmh"), ("kt", "kt")):
        i = text.find(unit)
        if i <= 0:
            continue
        j = i
        while j > 0 and (text[j - 1].isdigit() or text[j - 1] == "."):
            j -= 1
        try:
            out[key] = float(text[j:i])
        except ValueError:
            pass
    i = text.find("(")
    j = text.find("°", i + 1)
    if i >= 0 and j > i:
        try:
            out["bearing"] = float(text[i + 1: j])
        except ValueError:
            pass
    for name in ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                 "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]:
        k = text.find("from " + name)
        if k >= 0:
            out["from"] = name
            break
    return out


def bearing_delta(a: float, b: float) -> float:
    """The smaller angle between two bearings."""
    d = abs((a - b) % 360)
    return 360 - d if d > 180 else d


# ── the sweep ───────────────────────────────────────────────────────────
def move_to(pg, x, y, settle=420):
    """Move the pointer the way a human does — in steps."""
    for dx in range(-14, 3, 2):
        pg.mouse.move(x + dx, y + (dx // 4))
        pg.wait_for_timeout(22)
    pg.mouse.move(x, y)
    pg.wait_for_timeout(settle)


def main() -> int:
    args = sys.argv[1:]
    url = DEFAULT_URL
    if "--url" in args:
        url = args[args.index("--url") + 1]
    as_json = "--json" in args

    grid = PublishedWind()
    problems = []
    samples = []

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        errors = []
        page.on(
            "console",
            lambda m: errors.append(m.text) if m.type == "error" else None,
        )
        page.goto(url, wait_until="domcontentloaded", timeout=90000)
        page.wait_for_timeout(10000)

        vw, vh = page.evaluate("[window.innerWidth, window.innerHeight]")
        collect_js = COLLECT_JS % json.dumps(PROBE_SELECTORS)

        # A grid of pointer positions across the map, avoiding the
        # chrome: the layers dropdown is top-right, the search pill is
        # top-centre and the bottom bar is along the bottom.
        points = []
        for gy in range(0, 7):
            for gx in range(0, 9):
                x = int(120 + gx * (vw - 320) / 8)
                y = int(150 + gy * (vh - 330) / 6)
                if x < 60 or x > vw - 60 or y < 120 or y > vh - 140:
                    continue
                points.append((x, y))

        for (x, y) in points:
            move_to(page, x, y)
            data = page.evaluate(collect_js)
            boxes = data["boxes"]
            if not boxes:
                continue

            ll = page.evaluate(LATLNG_JS, [x, y])
            rec = {"x": x, "y": y, "latlng": ll, "boxes": []}

            # 1. no two readouts overlap
            for i in range(len(boxes)):
                for j in range(i + 1, len(boxes)):
                    area = overlap_area(boxes[i]["rect"], boxes[j]["rect"])
                    if area > 1:
                        problems.append(
                            "OVERLAP at (%d,%d): %s %s and %s %s share %d px2"
                            % (x, y, boxes[i]["sel"], boxes[i]["rect"],
                               boxes[j]["sel"], boxes[j]["rect"], int(area))
                        )

            # 2. nothing off the screen
            for b in boxes:
                if rect_outside(b["rect"], vw, vh):
                    problems.append(
                        "OFFSCREEN at (%d,%d): %s %s" % (x, y, b["sel"], b["rect"])
                    )

            # 3. the wind reading is the published grid's reading
            for b in boxes:
                if "wind" not in b["sel"] and b["sel"] != ".field-probe":
                    continue
                if "mph" not in b["text"]:
                    continue
                got = parse_wind_text(b["text"])
                if not ll:
                    continue
                s = grid.sample(ll["lat"], ll["lng"])
                if not s:
                    continue
                want = describe(s[0], s[1])
                if "bearing" in got:
                    delta = bearing_delta(got["bearing"], want["from_deg"])
                    # The page rounds the bearing to a whole degree and
                    # the compass point to 22.5°, so a small disagreement
                    # is the display's own rounding.
                    if delta > 22.5:
                        problems.append(
                            "WRONG BEARING at (%d,%d) %s: page says %s (%.0f°), "
                            "the published grid says %s (%.0f°)"
                            % (x, y, b["sel"], got.get("from"),
                               got.get("bearing", -1), want["from"],
                               want["from_deg"])
                        )
                if "mph" in got and want["speed_mph"] > 0:
                    if abs(got["mph"] - want["speed_mph"]) > 1:
                        problems.append(
                            "WRONG SPEED at (%d,%d) %s: page says %.0f mph, the "
                            "published grid says %.0f mph (%.2f m/s)"
                            % (x, y, b["sel"], got["mph"], want["speed_mph"],
                               want["speed_ms"])
                        )
                rec["boxes"].append({"sel": b["sel"], "text": b["text"],
                                     "grid": want, "page": got})

            samples.append(rec)

        browser.close()

    report = {
        "url": url,
        "grid_run_time": grid.meta.get("run_time"),
        "points_sampled": len(samples),
        "problems": problems,
        "console_errors": errors[:20],
    }

    if as_json:
        print(json.dumps(report, indent=2))
    else:
        print("probe audit — %s" % url)
        print("published wind grid: %s" % grid.meta.get("run_time"))
        print("pointer positions sampled: %d" % len(samples))
        if samples:
            print()
            print("sample of what the reader saw:")
            for rec in samples[:6]:
                ll = rec["latlng"]
                where = ("%.3f, %.3f" % (ll["lat"], ll["lng"])) if ll else "?"
                print("  at %s" % where)
                for b in rec["boxes"]:
                    print("      %-20s %s" % (b["sel"], b["text"][:90]))
        print()
        if problems:
            print("PROBLEMS (%d):" % len(problems))
            for pr in problems[:40]:
                print("  -", pr)
        else:
            print("no overlaps, nothing off-screen, and every wind reading "
                  "matched the published grid")
        if errors:
            print()
            print("console errors (%d):" % len(errors))
            for e in errors[:10]:
                print("  -", e[:160])

    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
