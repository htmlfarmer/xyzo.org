#!/usr/bin/env python3
"""
Build the tectonic fault / plate boundary overlay for Xyzo.

TWO SOURCES, TWO LICENCES, TWO DIRECTORIES — deliberately not one file.

  1. USGS (US Government work — PUBLIC DOMAIN)
     https://www.usgs.gov/programs/earthquake-hazards/google-earthtmkml-files
       • "Quaternary Faults & Folds in the U.S."  (a ~20 MB KMZ)
         https://earthquake.usgs.gov/static/lfs/nshm/qfaults/qfaults.kmz
         → the mapped fault traces of the United States, with the age of
           the most recent movement (historic → latest Quaternary), the
           slip sense, the slip rate and the fault class.
       • "Tectonic Plate Boundaries"
         https://earthquake.usgs.gov/learn/plate-boundaries.kmz
         → the global plate interfaces (transform / divergent /
           convergent) and the micro-plate / major fault zones.
     Published as:
       public_html/data/faults/faults.geojson
       public_html/data/faults/meta.json

  2. GEM Global Active Faults Database — CC BY-SA 4.0
     https://www.globalquakemodel.org/product/active-faults-database
     https://github.com/GEMScienceTools/gem-global-active-faults
       geojson/gem_active_faults.geojson  (16,195 traces, no login needed)
     → the global active-fault traces, which the USGS database does not
       cover (it is US-only). Without this the overlay would be empty
       outside North America.
     Published as:
       public_html/data/gem-faults/gem-faults.geojson
       public_html/data/gem-faults/meta.json

WHY TWO DIRECTORIES: the USGS data is public domain and the GEM data is
share-alike. Mixing them in one GeoJSON would drag the ShareAlike term
onto the public-domain half, so they are kept apart and the client
labels each one with its own attribution.

WHAT IS PUBLISHED
  • One LineString feature per mapped fault trace.
  • properties: {name, kind, age, min_zoom, section, fault_class, source}
    - `kind`   "plate-boundary" | "quaternary-fault" | "gem-active-fault"
    - `age`    the USGS age class ("historic", "latest Quaternary", …)
               or the GEM slip type ("Reverse", "Dextral", …)
    - `min_zoom` the zoom at which the trace first appears — the ladder
               below keeps a world view from being a hairball.
  • Coordinates are Douglas-Peucker simplified (0.01°) and quantised to
    4 decimals (~11 m).

Usage:
  python3 scripts/faults_build.py               # build from the cached sources
  python3 scripts/faults_build.py --refresh     # re-download the sources first
  python3 scripts/faults_build.py --verify-only # re-check the published files

The raw downloads are cached under maps/ — a KMZ IS a ZIP archive, so the
two USGS files are stored as usgs_plate_boundaries.zip and
usgs_qfaults.zip, and the GEM file as gem_active_faults.geojson. Those
names are already covered by the repo's "downloaded source datasets"
rules (maps/*.zip, maps/*.geojson), so nothing lands in git.
"""

from __future__ import annotations

import argparse
import collections
import json
import math
import os
import sys
import urllib.request
import zipfile
import xml.etree.ElementTree as ET

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── sources ───────────────────────────────────────────────────────────────
# The raw downloads live directly under maps/, where the repo's existing
# "downloaded source datasets" rules already keep them out of git
# (maps/*.zip and maps/*.geojson). A KMZ *is* a ZIP archive, so the two
# USGS downloads are stored under those names; the GEM file is a
# GeoJSON and keeps its own.
SRC_DIR = os.path.join(REPO, "maps")
PLATE_KMZ = os.path.join(SRC_DIR, "usgs_plate_boundaries.zip")
QFAULTS_KMZ = os.path.join(SRC_DIR, "usgs_qfaults.zip")
GEM_GEOJSON = os.path.join(SRC_DIR, "gem_active_faults.geojson")

# ── outputs ───────────────────────────────────────────────────────────────
OUT_DIR = os.path.join(REPO, "public_html", "data", "faults")
GEM_OUT_DIR = os.path.join(REPO, "public_html", "data", "gem-faults")

# ── URLs ──────────────────────────────────────────────────────────────────
USGS_LANDING = "https://www.usgs.gov/programs/earthquake-hazards/google-earthtmkml-files"
PLATE_URL = "https://earthquake.usgs.gov/learn/plate-boundaries.kmz"
QFAULTS_URL = "https://earthquake.usgs.gov/static/lfs/nshm/qfaults/qfaults.kmz"
GEM_URL = (
    "https://raw.githubusercontent.com/GEMScienceTools/gem-global-active-faults/"
    "master/geojson/gem_active_faults.geojson"
)
GEM_LANDING = "https://www.globalquakemodel.org/product/active-faults-database"

# ── licences ──────────────────────────────────────────────────────────────
# USGS output is a work of the US Government: public domain.
USGS_ATTRIBUTION = "USGS Earthquake Hazards Program — public domain"
USGS_LICENSE = "Public domain — US Government work (USGS)"
# GEM GAF-DB is CC BY-SA 4.0: attribution AND share-alike.
GEM_ATTRIBUTION = "GEM Global Active Faults Database (GEM GAF-DB) — Styron & Pagani (2020)"
GEM_LICENSE = "CC BY-SA 4.0"

USER_AGENT = "Mozilla/5.0 (compatible; Xyzo fault overlay builder)"

# ── the zoom ladder ───────────────────────────────────────────────────────
# A trace is drawn from `min_zoom` onwards, and the rule is SCREEN SIZE,
# not just importance: a trace has to be about 4 px long before it reads
# as a line instead of a smudge.
#
# One kilometre is 0.0064 · 2^z pixels at zoom z (360° of longitude is
# 256 · 2^z pixels and a degree is 111 km), so a 1 km trace only becomes
# a line at zoom 10 and a 20 km trace at zoom 5.
#
# The old ladder — length buckets at fixed zooms — put a 1 km trace on
# screen at zoom 6, where it is a QUARTER OF A PIXEL wide. That was
# 20,000 invisible paths over the United States at one zoom (measured in
# Chromium) and a hairball over the basemap.
PX_PER_KM_AT_Z0 = 0.006407
MIN_TRACE_PX = 4.0

# The AGE adjusts it, because recency is significance: a fault that moved
# in the last 150 years is worth seeing one zoom level earlier than a
# Quaternary fault of the same length.
AGE_ZOOM_ADJUST = {
    "historic": -1,
    "latest-quaternary": 0,
    "late-quaternary": 0,
    "middle-late-quaternary": 1,
    "undifferentiated-quaternary": 1,
    "class-b": 1,
    "unspecified": 1,
}
GEM_ZOOM_ADJUST = {
    "Unknown": 1,
}

# The shortest trace worth shipping. The USGS database's median segment is
# 0.4 km long — hundreds of thousands of them, and the file triples in
# size for a trace that is a couple of pixels wide at any zoom the map
# reaches. 1 km keeps the mapped fault network and drops the crumbs.
MIN_LENGTH_KM = 1.0

# Douglas-Peucker tolerance, in degrees. 0.01° ≈ 1.1 km — the same order
# as the minimum length, so a trace is never simplified below the length
# it is published at.
SIMPLIFY_TOL_DEG = 0.01
# Coordinate precision in the published file (4 decimals ≈ 11 m).
COORD_DECIMALS = 4

# The USGS age strings, verbatim from the database, mapped to a class.
USGS_AGE_CLASS = {
    "historic": "historic",
    "latest quaternary": "latest-quaternary",
    "late quaternary": "late-quaternary",
    "middle and late quaternary": "middle-late-quaternary",
    "undifferentiated quaternary": "undifferentiated-quaternary",
    "class b": "class-b",
    "": "unspecified",
}

# The colours the client uses. Published in meta.json so the legend and
# the map cannot drift apart.
USGS_AGE_COLORS = {
    "historic": "#ff4d6d",
    "latest-quaternary": "#ff9f43",
    "late-quaternary": "#ffd166",
    "middle-late-quaternary": "#8ecae6",
    "undifferentiated-quaternary": "#5e8ca8",
    "class-b": "#8b9bb4",
    "unspecified": "#8b9bb4",
}
PLATE_BOUNDARY_COLOR = "#ffffff"

# GEM slip types → a small, restrained family so the second dataset reads
# as "another source" rather than as more USGS faults.
GEM_SLIP_COLORS = {
    "Normal": "#7dd3fc",
    "Reverse": "#c4b5fd",
    "Dextral": "#5eead4",
    "Sinistral": "#5eead4",
    "Subduction_Thrust": "#f0abfc",
    "Spreading_Ridge": "#86efac",
    "Transpressional": "#a3e635",
    "Transtensional": "#bef264",
    "Unknown": "#8b9bb4",
}

# ── the probes ────────────────────────────────────────────────────────────
# verify() is a GATE, not a checkpoint. Every count can be right and the
# geometry still be wrong: a swapped lat/lon, a mirrored hemisphere or a
# truncated download all produce a plausible-looking file. Only known
# places catch that.
#
#   (label, kind, lat, lng, tolerance_km, name must contain)
PROBES = [
    ("San Andreas", "quaternary-fault", 37.80, -122.30, 60.0, "san andreas"),
    ("Hayward", "quaternary-fault", 37.80, -122.25, 60.0, "hayward"),
    ("Aleutian plate boundary", "plate-boundary", 55.00, -150.00, 400.0, None),
    ("Mid-Atlantic ridge", "plate-boundary", 0.00, -30.00, 400.0, None),
    ("Alpine fault (GEM)", "gem-active-fault", -42.50, 172.50, 120.0, "alpine"),
]

# The swap guard. If lat and lon were exchanged, the San Andreas trace
# would land in the sea east of the Philippines (122.3°E, 37.8°N) — a
# perfectly valid coordinate, so only an explicit negative probe finds it.
#
# It is scoped to the QUATERNARY FAULTS, which are the United States
# only: nothing of theirs may be in the Yellow Sea. The plate boundaries
# are global and DO have a trace there (a micro-plate fault zone in the
# Yellow Sea), so guarding them against this position would be a false
# alarm.
SWAP_GUARD = (37.80, 122.30, 300.0)

# The named trace that must not move: every feature whose name mentions
# the San Andreas has to be inside this radius of the real one.
#
# The radius is deliberately generous (the "San Andreas fault zone" runs
# the length of California, so its sections are up to ~700 km from the
# Hayward) — it only has to be tight enough that the SWAPPED position
# (122.3°E, 37.8°N, ten thousand kilometres away) cannot pass.
SAN_ANDREAS_AT = (37.80, -122.30, 900.0)

KML_NS = "http://www.opengis.net/kml/2.2"
GX_NS = "http://www.google.com/kml/ext/2.2"
KML = "{%s}" % KML_NS
GX = "{%s}" % GX_NS


def log(msg: str) -> None:
    print(f"[faults] {msg}", flush=True)


# ── geometry helpers ──────────────────────────────────────────────────────
def douglas_peucker(points, tol: float):
    """Iterative Douglas-Peucker.

    Iterative on purpose: a recursive version blows the stack on a long
    fault trace (the recursion depth is the number of points kept).
    """
    n = len(points)
    if n <= 2:
        return list(points)
    tol2 = tol * tol
    keep = [False] * n
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        ax, ay = points[first]
        bx, by = points[last]
        dx, dy = bx - ax, by - ay
        den = dx * dx + dy * dy
        best = -1.0
        best_i = -1
        for i in range(first + 1, last):
            x, y = points[i]
            if den == 0.0:
                d = (x - ax) ** 2 + (y - ay) ** 2
            else:
                t = ((x - ax) * dx + (y - ay) * dy) / den
                if t < 0.0:
                    t = 0.0
                elif t > 1.0:
                    t = 1.0
                ex = x - (ax + t * dx)
                ey = y - (ay + t * dy)
                d = ex * ex + ey * ey
            if d > best:
                best = d
                best_i = i
        if best > tol2 and best_i > 0:
            keep[best_i] = True
            stack.append((first, best_i))
            stack.append((best_i, last))
    return [points[i] for i in range(n) if keep[i]]


def length_km(points) -> float:
    """Length of a lon/lat polyline in kilometres.

    Longitude degrees shrink by cos(lat), so a degree of longitude is
    111.32·cos(lat) km and a degree of latitude is always ~110.57 km.
    """
    total = 0.0
    for i in range(1, len(points)):
        lon0, lat0 = points[i - 1]
        lon1, lat1 = points[i]
        mid = math.radians((lat0 + lat1) / 2.0)
        dx = (lon1 - lon0) * 111.320 * math.cos(mid)
        dy = (lat1 - lat0) * 110.574
        total += math.hypot(dx, dy)
    return total


def min_zoom_for(length: float, adjust: int = 0) -> int:
    zoom = LENGTH_LADDER[-1][1]
    for threshold, z in LENGTH_LADDER:
        if length >= threshold:
            zoom = z
            break
    return max(0, min(10, zoom + adjust))


def quantise(points):
    return [[round(lon, COORD_DECIMALS), round(lat, COORD_DECIMALS)]
            for lon, lat in points]


# ── KML parsing ───────────────────────────────────────────────────────────
_ATTR_RE = None
_TAG_RE = None


def parse_description(desc: str) -> dict:
    """Pull the attribute table out of a KML placemark description.

    The USGS placemarks carry an HTML table of `<td>KEY</td><td>VALUE</td>`
    rows. Values may contain markup (the fault-url row is an anchor), so
    the tags are stripped after the row is matched.
    """
    global _ATTR_RE, _TAG_RE
    if _ATTR_RE is None:
        import re
        _ATTR_RE = re.compile(r"<td>([^<]{1,60})</td>\s*<td>(.*?)</td>", re.S)
        _TAG_RE = re.compile(r"<[^>]+>")
    out: dict = {}
    if not desc:
        return out
    for key, value in _ATTR_RE.findall(desc):
        value = _TAG_RE.sub("", value)
        value = value.replace("&amp;", "&").replace("&nbsp;", " ").strip()
        if value:
            out[key.strip()] = value
    return out


def parse_coordinates(text: str):
    """KML `<coordinates>` → a list of (lon, lat) pairs."""
    pts = []
    for token in (text or "").split():
        parts = token.split(",")
        if len(parts) < 2:
            continue
        try:
            lon = float(parts[0])
            lat = float(parts[1])
        except ValueError:
            continue
        pts.append((lon, lat))
    return pts


def iter_kml_placemarks(fh):
    """Stream the placemarks out of a KML document.

    The Quaternary Fault KMZ unpacks to a 440 MB doc.kml, so it cannot be
    parsed as a tree — this walks it with iterparse, opening each
    placemark on its start event and clearing it on its end event, so
    the peak memory is one placemark.

    Yields dicts: {folder, name, desc, lines}
      folder  the chain of enclosing folder names
      lines   a list of (lon, lat) lists — one per LineString / gx:Track
    """
    stack: list = []
    folder_names: list = []
    current = None
    track = None

    for event, el in ET.iterparse(fh, events=("start", "end")):
        if event == "start":
            stack.append(el)
            if el.tag == KML + "Folder":
                folder_names.append("")
            elif el.tag == KML + "Placemark":
                current = {"folder": list(folder_names), "name": "",
                           "desc": "", "lines": [], "track": []}
            elif el.tag == GX + "Track":
                track = []
            continue

        tag = el.tag
        parent = stack[-2] if len(stack) >= 2 else None

        if tag == KML + "name":
            text = (el.text or "").strip()
            if parent is not None and parent.tag == KML + "Folder":
                if folder_names:
                    folder_names[-1] = text
            elif parent is not None and parent.tag == KML + "Placemark" and current is not None:
                current["name"] = text
        elif tag == KML + "description":
            if parent is not None and parent.tag == KML + "Placemark" and current is not None:
                current["desc"] = el.text or ""
        elif tag == KML + "coordinates":
            if current is not None:
                pts = parse_coordinates(el.text)
                if len(pts) >= 2:
                    current["lines"].append(pts)
        elif tag == GX + "coord":
            if current is not None and track is not None:
                parts = (el.text or "").split()
                if len(parts) >= 2:
                    try:
                        track.append((float(parts[0]), float(parts[1])))
                    except ValueError:
                        pass
        elif tag == GX + "Track":
            if current is not None and len(track) >= 2:
                current["lines"].append(track)
            track = None
        elif tag == KML + "Placemark":
            if current is not None:
                yield current
                current = None
                el.clear()
                if parent is not None:
                    try:
                        parent.remove(el)
                    except ValueError:
                        pass
        elif tag == KML + "Folder":
            if folder_names:
                folder_names.pop()

        stack.pop()


# ── the USGS plate boundaries ─────────────────────────────────────────────
def build_plate_boundaries():
    """The global plate interfaces + micro-plate fault zones."""
    features = []
    kinds = collections.Counter()
    with zipfile.ZipFile(PLATE_KMZ) as zf:
        with zf.open("doc.kml") as fh:
            for pm in iter_kml_placemarks(fh):
                attrs = parse_description(pm["desc"])
                boundary_type = attrs.get("LABEL") or attrs.get("Boundary Type") or ""
                name = pm["name"] or attrs.get("NAME") or ""
                folder = pm["folder"][-1] if pm["folder"] else ""
                for pts in pm["lines"]:
                    km = length_km(pts)
                    if km < 1.0:
                        continue
                    pts = douglas_peucker(pts, SIMPLIFY_TOL_DEG)
                    if len(pts) < 2:
                        continue
                    props = {
                        "name": name.strip() or "Plate boundary",
                        "kind": "plate-boundary",
                        "age": boundary_type.strip() or "Plate boundary",
                        "min_zoom": 0,
                        "source": "usgs-plate-boundaries",
                    }
                    if folder:
                        props["group"] = folder
                    features.append({
                        "type": "Feature",
                        "geometry": {"type": "LineString",
                                     "coordinates": quantise(pts)},
                        "properties": props,
                    })
                    kinds[boundary_type.strip() or "Plate boundary"] += 1
    return features, kinds


# ── the USGS Quaternary faults ────────────────────────────────────────────
def build_quaternary_faults():
    """The mapped fault traces of the United States."""
    features = []
    ages = collections.Counter()
    dropped_short = 0
    with zipfile.ZipFile(QFAULTS_KMZ) as zf:
        with zf.open("doc.kml") as fh:
            for pm in iter_kml_placemarks(fh):
                attrs = parse_description(pm["desc"])
                age_raw = (attrs.get("Age") or "").strip()
                age_class = USGS_AGE_CLASS.get(age_raw.lower(), "unspecified")
                name = (pm["name"] or "").strip() or attrs.get("Fault Name", "").strip()
                section = (attrs.get("Section Name") or "").strip()
                fault_class = (attrs.get("Fault Class") or "").strip()
                adjust = AGE_ZOOM_ADJUST.get(age_class, 0)
                for pts in pm["lines"]:
                    km = length_km(pts)
                    if km < MIN_LENGTH_KM:
                        dropped_short += 1
                        continue
                    pts = douglas_peucker(pts, SIMPLIFY_TOL_DEG)
                    if len(pts) < 2:
                        continue
                    props = {
                        "name": name or "Unnamed fault",
                        "kind": "quaternary-fault",
                        "age": age_raw or "unspecified",
                        "min_zoom": min_zoom_for(km, adjust),
                        "source": "usgs-qfaults",
                    }
                    if section:
                        props["section"] = section
                    if fault_class:
                        props["fault_class"] = fault_class
                    features.append({
                        "type": "Feature",
                        "geometry": {"type": "LineString",
                                     "coordinates": quantise(pts)},
                        "properties": props,
                    })
                    ages[age_class] += 1
    return features, ages, dropped_short


# ── the GEM global active faults ──────────────────────────────────────────
def build_gem_faults():
    """The global active-fault traces (CC BY-SA 4.0)."""
    with open(GEM_GEOJSON, encoding="utf-8") as fh:
        fc = json.load(fh)
    features = []
    slips = collections.Counter()
    dropped_short = 0
    for f in fc.get("features", []):
        geom = f.get("geometry") or {}
        if geom.get("type") != "LineString":
            continue
        props = f.get("properties") or {}
        slip = (props.get("slip_type") or "Unknown").strip() or "Unknown"
        name = (props.get("name") or "").strip()
        adjust = GEM_ZOOM_ADJUST.get(slip, 0)
        for pts in [[(c[0], c[1]) for c in geom["coordinates"]]]:
            km = length_km(pts)
            if km < MIN_LENGTH_KM:
                dropped_short += 1
                continue
            pts = douglas_peucker(pts, SIMPLIFY_TOL_DEG)
            if len(pts) < 2:
                continue
            out = {
                "name": name or "Active fault",
                "kind": "gem-active-fault",
                "age": slip,
                "min_zoom": min_zoom_for(km, adjust),
                "source": "gem-gafd",
            }
            features.append({
                "type": "Feature",
                "geometry": {"type": "LineString",
                             "coordinates": quantise(pts)},
                "properties": out,
            })
            slips[slip] += 1
    return features, slips, dropped_short


# ── the gate ──────────────────────────────────────────────────────────────
def _segment_distance(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    den = dx * dx + dy * dy
    if den == 0.0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / den
    if t < 0.0:
        t = 0.0
    elif t > 1.0:
        t = 1.0
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _nearest(features, kind, lat, lng, name_contains=None):
    """(distance_km, feature) of the closest feature of `kind`."""
    cos_lat = math.cos(math.radians(lat))
    px = lng * cos_lat
    py = lat
    best = None
    best_d = float("inf")
    for f in features:
        p = f["properties"]
        if p.get("kind") != kind:
            continue
        if name_contains and name_contains not in (p.get("name") or "").lower():
            continue
        coords = f["geometry"]["coordinates"]
        for i in range(1, len(coords)):
            ax = coords[i - 1][0] * cos_lat
            ay = coords[i - 1][1]
            bx = coords[i][0] * cos_lat
            by = coords[i][1]
            d = _segment_distance(px, py, ax, ay, bx, by)
            if d < best_d:
                best_d = d
                best = f
    return best_d * 111.320, best


def verify(all_features) -> None:
    """A GATE: raise SystemExit before anything is published."""
    problems = []

    by_kind = collections.Counter(f["properties"].get("kind") for f in all_features)
    log(f"verify: {dict(by_kind)}")

    for label, kind, lat, lng, tol_km, name in PROBES:
        dist, feat = _nearest(all_features, kind, lat, lng, name)
        good = feat is not None and dist <= tol_km
        where = ""
        if feat is not None:
            where = feat["properties"].get("name", "")[:38]
        log(f"verify:   {'ok ' if good else 'FAIL'} {label:24s} "
            f"({lat:6.2f},{lng:8.2f}) -> {dist:8.1f} km  {where}")
        if not good:
            problems.append(
                f"{label}: closest {kind} is {dist:.0f} km away (limit {tol_km:.0f} km)"
            )

    # The swap guard: nothing may sit in the sea east of the Philippines,
    # which is where the San Andreas lands if lat and lon are exchanged.
    # Scoped to the US-only Quaternary faults (see SWAP_GUARD).
    lat, lng, tol_km = SWAP_GUARD
    dist, feat = _nearest(all_features, "quaternary-fault", lat, lng)
    if feat is not None and dist <= tol_km:
        problems.append(
            f"a Quaternary fault sits {dist:.0f} km from the swapped position "
            f"({lat},{lng}) — the coordinates look exchanged"
        )
        log(f"verify:   FAIL swap-guard quaternary-fault at {dist:.0f} km from "
            f"({lat},{lng}) — coordinates look exchanged")

    # Every trace NAMED after the San Andreas must be at the San Andreas.
    # A swapped axis moves the whole set at once, and this catches it by
    # name rather than by position.
    lat, lng, tol_km = SAN_ANDREAS_AT
    cos_lat = math.cos(math.radians(lat))
    named = 0
    for f in all_features:
        if "san andreas" not in (f["properties"].get("name") or "").lower():
            continue
        named += 1
        coords = f["geometry"]["coordinates"]
        best_d = min(
            _segment_distance(
                lng * cos_lat, lat,
                coords[i - 1][0] * cos_lat, coords[i - 1][1],
                coords[i][0] * cos_lat, coords[i][1],
            )
            for i in range(1, len(coords))
        ) * 111.320
        if best_d > tol_km:
            problems.append(
                f"'{f['properties'].get('name')}' is {best_d:.0f} km from the "
                f"San Andreas (limit {tol_km:.0f} km) — the coordinates look exchanged"
            )
    log(f"verify:   {named} features named after the San Andreas, all within "
        f"{tol_km:.0f} km of ({lat},{lng})")
    if named < 10:
        problems.append(f"only {named} features named after the San Andreas")

    # Every coordinate must be a real place on Earth.
    bad = 0
    for f in all_features:
        for lon, lat in f["geometry"]["coordinates"]:
            if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
                bad += 1
                break
    if bad:
        problems.append(f"{bad} features carry an impossible coordinate")

    # The United States must actually be in there — a US-only dataset
    # that lost its coordinates reads as empty.
    us = sum(1 for f in all_features
             if f["properties"].get("kind") == "quaternary-fault"
             and -125.0 <= f["geometry"]["coordinates"][0][0] <= -66.0
             and 24.0 <= f["geometry"]["coordinates"][0][1] <= 50.0)
    log(f"verify:   {us} Quaternary fault features start inside the contiguous US")
    if us < 100:
        problems.append(f"only {us} Quaternary faults inside the US")

    if problems:
        for p in problems:
            print(f"[faults] VERIFY FAIL: {p}")
        raise SystemExit("verify() failed — refusing to publish")
    log(f"verify() passed: {len(PROBES)} probes, {len(all_features)} features")


# ── writing ───────────────────────────────────────────────────────────────
def write_geojson(path: str, features) -> int:
    fc = {"type": "FeatureCollection", "features": features}
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(fc, fh, separators=(",", ":"), ensure_ascii=False)
    return os.path.getsize(path)


def write_meta(path: str, meta: dict) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=1, ensure_ascii=False)


# ── downloads ─────────────────────────────────────────────────────────────
def download(url: str, dest: str) -> None:
    log(f"downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    tmp = dest + ".part"
    with urllib.request.urlopen(req, timeout=300) as resp, open(tmp, "wb") as out:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
    os.replace(tmp, dest)
    log(f"  → {dest} ({os.path.getsize(dest) / 1e6:.1f} MB)")


def ensure_sources(refresh: bool) -> None:
    os.makedirs(SRC_DIR, exist_ok=True)
    wanted = [
        (PLATE_URL, PLATE_KMZ),
        (QFAULTS_URL, QFAULTS_KMZ),
        (GEM_URL, GEM_GEOJSON),
    ]
    for url, dest in wanted:
        if refresh or not os.path.exists(dest):
            download(url, dest)
        else:
            log(f"cached {os.path.basename(dest)} "
                f"({os.path.getsize(dest) / 1e6:.1f} MB) — use --refresh to refetch")


# ── main ──────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser(description="Build the tectonic fault overlay")
    ap.add_argument("--out", default=OUT_DIR, help="output dir for the USGS files")
    ap.add_argument("--gem-out", default=GEM_OUT_DIR, help="output dir for the GEM files")
    ap.add_argument("--verify-only", action="store_true",
                    help="re-check the published files without rebuilding")
    ap.add_argument("--refresh", action="store_true",
                    help="re-download the sources before building")
    args = ap.parse_args()

    if args.verify_only:
        published = []
        for d, name in ((args.out, "faults.geojson"), (args.gem_out, "gem-faults.geojson")):
            p = os.path.join(d, name)
            if not os.path.exists(p):
                print(f"[faults] no {p}", file=sys.stderr)
                return 1
            with open(p, encoding="utf-8") as fh:
                published.extend(json.load(fh)["features"])
        verify(published)
        return 0

    ensure_sources(args.refresh)

    plate, plate_kinds = build_plate_boundaries()
    log(f"plate boundaries: {len(plate)} segments ({dict(plate_kinds)})")

    qf, qf_ages, qf_dropped = build_quaternary_faults()
    log(f"quaternary faults: {len(qf)} traces "
        f"(dropped {qf_dropped} under {MIN_LENGTH_KM} km) {dict(qf_ages)}")

    gem, gem_slips, gem_dropped = build_gem_faults()
    log(f"GEM active faults: {len(gem)} traces "
        f"(dropped {gem_dropped} under {MIN_LENGTH_KM} km) {dict(gem_slips)}")

    usgs_features = plate + qf
    verify(usgs_features + gem)

    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.gem_out, exist_ok=True)

    usgs_path = os.path.join(args.out, "faults.geojson")
    size = write_geojson(usgs_path, usgs_features)
    log(f"wrote {usgs_path} ({size / 1e6:.2f} MB, {len(usgs_features)} features)")

    min_zooms = collections.Counter(f["properties"]["min_zoom"] for f in usgs_features)
    write_meta(os.path.join(args.out, "meta.json"), {
        "name": "Tectonic faults (USGS)",
        "source": USGS_LANDING,
        "download": [PLATE_URL, QFAULTS_URL],
        "attribution": USGS_ATTRIBUTION,
        "license": USGS_LICENSE,
        "geojson": "faults.geojson",
        "feature_count": len(usgs_features),
        "plate_boundary_count": len(plate),
        "quaternary_fault_count": len(qf),
        "kinds": {
            "plate-boundary": {
                "label": "Plate boundary",
                "color": PLATE_BOUNDARY_COLOR,
                "min_zoom": 0,
            },
            "quaternary-fault": {
                "label": "Quaternary fault (USGS)",
                "color": USGS_AGE_COLORS,
            },
        },
        "age_colors": USGS_AGE_COLORS,
        "plate_boundary_colors": {
            "Transform Boundary": PLATE_BOUNDARY_COLOR,
            "Divergent Boundary": PLATE_BOUNDARY_COLOR,
            "Convergent Boundary": PLATE_BOUNDARY_COLOR,
            "Other": PLATE_BOUNDARY_COLOR,
        },
        "boundary_types": dict(plate_kinds),
        "age_classes": dict(qf_ages),
        "min_zoom_histogram": {str(k): v for k, v in sorted(min_zooms.items())},
        "length_ladder": [{"min_km": t, "min_zoom": z} for t, z in LENGTH_LADDER],
        "min_length_km": MIN_LENGTH_KM,
        "simplify_tol_deg": SIMPLIFY_TOL_DEG,
        "coordinate_decimals": COORD_DECIMALS,
        "note": (
            "Plate boundaries are the USGS global plate interfaces; the fault "
            "traces are the USGS Quaternary Fault and Fold Database, coloured "
            "by the age of the most recent movement. A trace appears from its "
            "min_zoom onwards, so a world view shows the plate skeleton and a "
            "city view shows the local fault network."
        ),
    })
    log(f"wrote {os.path.join(args.out, 'meta.json')}")

    gem_path = os.path.join(args.gem_out, "gem-faults.geojson")
    gsize = write_geojson(gem_path, gem)
    log(f"wrote {gem_path} ({gsize / 1e6:.2f} MB, {len(gem)} features)")

    gmin = collections.Counter(f["properties"]["min_zoom"] for f in gem)
    write_meta(os.path.join(args.gem_out, "meta.json"), {
        "name": "Global active faults (GEM GAF-DB)",
        "source": GEM_LANDING,
        "download": [GEM_URL],
        "attribution": GEM_ATTRIBUTION,
        "license": GEM_LICENSE,
        "license_url": "https://creativecommons.org/licenses/by-sa/4.0/",
        "doi": "10.1177/8755293020944182",
        "citation": (
            "Styron, Richard, and Marco Pagani. \"The GEM Global Active Faults "
            "Database.\" Earthquake Spectra, vol. 36, no. 1_suppl, Oct. 2020, "
            "pp. 160–180, doi:10.1177/8755293020944182."
        ),
        "geojson": "gem-faults.geojson",
        "feature_count": len(gem),
        "kinds": {
            "gem-active-fault": {
                "label": "Active fault (GEM)",
                "color": GEM_SLIP_COLORS,
            },
        },
        "slip_colors": GEM_SLIP_COLORS,
        "slip_types": dict(gem_slips),
        "min_zoom_histogram": {str(k): v for k, v in sorted(gmin.items())},
        "min_length_km": MIN_LENGTH_KM,
        "simplify_tol_deg": SIMPLIFY_TOL_DEG,
        "coordinate_decimals": COORD_DECIMALS,
        "note": (
            "The global active-fault traces, coloured by slip type. The "
            "USGS Quaternary Fault database covers the United States only, so "
            "this is what puts fault traces on the rest of the world. "
            "CC BY-SA 4.0: attribution and share-alike."
        ),
    })
    log(f"wrote {os.path.join(args.gem_out, 'meta.json')}")

    total = size + gsize
    log(f"done — {total / 1e6:.2f} MB of GeoJSON in total")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
