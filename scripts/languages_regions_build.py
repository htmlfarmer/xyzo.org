#!/usr/bin/env python3
"""
Build the LANGUAGE REGIONS overlay for Xyzo — the world's languages by
country, as vector regions.

Sources
-------
* **Glottolog** — the free, authoritative database of the world's
  languages, from the Max Planck Institute for Geoanthropology.
  **CC BY-SA 4.0** (the same licence the existing points overlay carries).
    `maps/glottolog_languoid.csv` — the FULL languoid table (27,177 rows:
    families, languages and dialects). Its `country_ids` column is the
    space-separated list of ISO 3166-1 alpha-2 codes of the countries a
    language is spoken in (9,094 rows carry one).
    `maps/glottolog_languages_geo.csv` — the same database's geo export.
    It is read here ONLY for the `macroarea` column (the languoid table
    does not carry one); the points product is built from it by
    `scripts/languages_build.py`, which stays the single source of truth
    for that side of the overlay.
* **Natural Earth 50m admin-0 countries** — public domain.
    `maps/ne_50m_admin_0_countries.zip`

Published
---------
    public_html/data/languages/regions.geojson   one polygon per country
    public_html/data/languages/meta.json          REGENERATED: describes
                                                   BOTH products — the
                                                   points (unchanged keys)
                                                   and the new regions block

WHY REGIONS, AND WHAT THEY ARE NOT
----------------------------------
The owner asked for a vector map of *where each language is*, and the
honest answer is that Glottolog cannot give one: it records a language's
TERRITORY (the countries it is spoken in), never an EXTENT. There is no
boundary of a speech community in the data, and inventing one from the
language's representative point would be a fabrication.

So the region is the COUNTRY. Natural Earth's admin-0 polygons supply
the geometry, Glottolog supplies the contents, and the overlay says
honestly what it is: a choropleth of *how many Glottolog languages are
spoken in each country*, with the probe listing them.

That is also why this is a DIFFERENT product from the points overlay and
not a replacement for it. A one-polygon-per-language-area map can only
ever show ONE language per area — where several share a territory (the
Papua New Guinea highlands, the Amazon, the Caucasus) the topmost
polygon hides the rest. The points overlay answers "which languages are
here, one dot each"; this one answers "how dense is this country, and
which languages are in it". Both are published; they are different
questions.

A language listed for forty countries (English) therefore appears in
forty regions, and a country's polygon covers the whole country — not
just the places the language is actually spoken. The per-language
territory is the points layer's job.

Usage:
    python3 -m scripts.languages_regions_build
    python3 -m scripts.languages_regions_build --verify-only
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from collections import Counter, defaultdict

try:
    from osgeo import ogr
except ImportError as exc:  # pragma: no cover
    print(f"GDAL/OGR required: {exc}", file=sys.stderr)
    raise

ogr.UseExceptions()

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

# The points product's own builder. Imported (never re-implemented) so
# the two halves of the overlay can never disagree about the counts.
#
# It is loaded BY PATH, not as `scripts.languages_build`: `scripts/` is a
# namespace package and a user site-packages can ship a regular package
# called `scripts` (this box does — an ML toolkit), which shadows it.
# A path load cannot be shadowed.
def _load_sibling(module_name: str, filename: str):
    import importlib.util
    path = os.path.join(REPO, "scripts", filename)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_languages_build = _load_sibling("xyzo_languages_build", "languages_build.py")
build_point_product = _languages_build.build
read_geo_rows = _languages_build.read_rows

SRC_ZIP = os.path.join(REPO, "maps", "ne_50m_admin_0_countries.zip")
LANGUID_CSV = os.path.join(REPO, "maps", "glottolog_languoid.csv")
GEO_CSV = os.path.join(REPO, "maps", "glottolog_languages_geo.csv")
OUT_DIR = os.path.join(REPO, "public_html", "data", "languages")

SOURCE_URL = "https://glottolog.org/meta/downloads"
DOWNLOAD_URL = (
    "https://cdstar.eva.mpg.de/bitstreams/EAEA0-608B-9919-A962-0/"
    "languages_and_dialects_geo.csv"
)
ATTRIBUTION = "Glottolog — Max Planck Institute for Geoanthropology"
LICENSE = "CC BY-SA 4.0"
NE_URL = (
    "https://www.naturalearthdata.com/downloads/50m-cultural-vectors/"
    "50m-admin-0-countries/"
)
NE_ATTRIBUTION = "Natural Earth — Admin 0 countries, 1:50m (public domain)"
NE_LICENSE = "Public domain — Natural Earth"

# How many languages are listed per region. Papua New Guinea has 928
# Glottolog languoids — the only region that exceeds the cap — so the
# file records how many there are (`languages_total`) and how many are
# listed (`languages`), and the probe says "+428 more" instead of
# quietly truncating.
MAX_LANGUAGES = 500

# Douglas-Peucker tolerance for the country outlines, in degrees.
# 0.03° ≈ 3.3 km — under one screen pixel at zoom 6, and it takes the
# 50m layer from 3.1 MB to 1.8 MB on the wire.
SIMPLIFY_DEG = 0.03
COORD_PRECISION = 4

# ── the join ────────────────────────────────────────────────────────────
# Glottolog's `country_ids` are ISO 3166-1 alpha-2. Natural Earth
# carries the same codes in ISO_A2, but three entities need a hand:
# France and Norway carry the "-99" placeholder (NE treats their ISO
# codes as disputed because of their overseas territories), and Taiwan
# carries the "CN-TW" form. All three are named explicitly.
NE_A2_OVERRIDE = {
    "France": "FR",
    "Norway": "NO",
    "Taiwan": "TW",
}

# Glottolog lists a few territories Natural Earth's country layer does
# not carry as a country of their own. Where the territory sits INSIDE
# its sovereign's Natural Earth polygon the languages belong to that
# region; the rest are attributed to the sovereign state. Every entry is
# a decision, so each one says why.
TERRITORY_ALIAS = {
    "GF": "FR",   # French Guiana — inside NE's France polygon
    "GP": "FR",   # Guadeloupe — inside NE's France polygon
    "MQ": "FR",   # Martinique — inside NE's France polygon
    "RE": "FR",   # Réunion — inside NE's France polygon
    "YT": "FR",   # Mayotte — inside NE's France polygon
    "SJ": "NO",   # Svalbard and Jan Mayen — inside NE's Norway polygon
    "BQ": "NL",   # Bonaire — inside NE's Netherlands polygon
    "CC": "AU",   # Cocos (Keeling) Islands — Australian external territory
    "CX": "AU",   # Christmas Island — Australian external territory
    "GI": "GB",   # Gibraltar — British Overseas Territory
    "TK": "NZ",   # Tokelau — New Zealand dependent territory
    "UM": "US",   # US Minor Outlying Islands
}

# ── the probes ──────────────────────────────────────────────────────────
# A language must land in its known region. The names are real Glottolog
# languoids in the table above; a swapped join (or a swapped axis) puts
# every one of them in the wrong country.
LANGUAGE_PROBES = [
    ("Aasax", "Tanzania"),
    ("Aari", "Ethiopia"),
    ("Abadi", "Papua New Guinea"),
    ("Basque", "Spain"),
    ("Hokkaido Ainu", "Japan"),
    ("Wintu", "United States"),
    ("Northern Amis", "Taiwan"),
    ("Papiamento", "Netherlands"),   # Bonaire — inside NE's NL polygon
]

# The other half of the same check: a language must NOT land in a country
# it has nothing to do with. A join that dumps every language into every
# region passes the positive probes above.
NEGATIVE_PROBES = [
    ("Aasax", "Kenya"),
    ("Aari", "Brazil"),
    ("Wintu", "Japan"),
    ("Basque", "Ethiopia"),
    ("Northern Amis", "Spain"),
]

# The representative point of a region must land inside that region, and
# inside the right HEMISPHERE. A swapped coordinate order (lon <-> lat)
# puts Ethiopia's languages in the Indian Ocean: these boxes are the
# axis check, and they are loose enough to survive a country that has
# distant overseas parts.
POINT_PROBES = [
    ("Ethiopia", 30.0, 50.0, 0.0, 15.0),
    ("Kenya", 33.0, 42.0, -5.0, 6.0),
    ("Papua New Guinea", 138.0, 155.0, -13.0, 3.0),
    ("Brazil", -75.0, -34.0, -35.0, 6.0),
    ("India", 68.0, 98.0, 6.0, 36.0),
    ("Spain", -10.0, 5.0, 35.0, 44.0),
    ("Japan", 125.0, 150.0, 25.0, 46.0),
    ("Chile", -76.0, -65.0, -56.0, -17.0),
    ("Australia", 112.0, 154.0, -44.0, -10.0),
    ("United States", -130.0, -65.0, 20.0, 50.0),
]

# How many languoids carry a country at all — the number the region
# counts have to add up to.
EXPECTED_LANGUAGES_WITH_COUNTRY = 9094


def log(msg: str) -> None:
    print(f"[lang-regions] {msg}", flush=True)


# ── geometry helpers (pure Python, so the gate tests the PUBLISHED file) ──

def point_in_ring(lng: float, lat: float, ring: list) -> bool:
    """Ray casting on one closed ring (the even-odd rule)."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat):
            x = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lng < x:
                inside = not inside
        j = i
    return inside


def point_in_polygon(lng: float, lat: float, poly: list) -> bool:
    """One polygon: an outer ring minus its holes."""
    if not poly or not point_in_ring(lng, lat, poly[0]):
        return False
    for hole in poly[1:]:
        if point_in_ring(lng, lat, hole):
            return False
    return True


def point_in_geometry(lng: float, lat: float, geom: dict) -> bool:
    if not geom:
        return False
    if geom.get("type") == "Polygon":
        return point_in_polygon(lng, lat, geom["coordinates"])
    if geom.get("type") == "MultiPolygon":
        for poly in geom["coordinates"]:
            if point_in_polygon(lng, lat, poly):
                return True
    return False


def round_coords(obj, nd: int = COORD_PRECISION):
    """Round every coordinate in a GeoJSON geometry to `nd` decimals."""
    if not obj:
        return obj
    if isinstance(obj[0], (int, float)):
        return [round(obj[0], nd), round(obj[1], nd)]
    return [round_coords(x, nd) for x in obj]


def ring_area_deg2(ring: list) -> float:
    """Absolute planar area of a ring in square degrees — a size proxy
    good enough to pick a country's MAIN part."""
    total = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


# ── sources ─────────────────────────────────────────────────────────────

def extract_countries(zip_path: str) -> tuple[str, str]:
    """Unpack the Natural Earth zip; return (temp dir, .shp path)."""
    if not os.path.exists(zip_path):
        raise SystemExit(
            f"Source missing: {zip_path}\n"
            f"Download it from {NE_URL} and save it there."
        )
    tmp = tempfile.mkdtemp(prefix="langregions_src_")
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(tmp)
    shp = None
    for name in sorted(os.listdir(tmp)):
        if name.endswith(".shp"):
            shp = os.path.join(tmp, name)
            break
    if not shp:
        raise SystemExit("no .shp inside the Natural Earth zip")
    log(f"source {os.path.basename(zip_path)}: "
        f"{os.path.getsize(zip_path) / 1e6:.1f} MB")
    return tmp, shp


def run_ogr(args: list[str]) -> None:
    proc = subprocess.run(
        ["ogr2ogr", *args], capture_output=True, text=True, timeout=1800
    )
    if proc.returncode != 0:
        raise SystemExit(f"ogr2ogr failed:\n{proc.stderr[-2000:]}")


def convert_countries(shp: str, out_geojson: str, simplify: float) -> None:
    """Shapefile → GeoJSON, cut at the antimeridian and simplified.

    -wrapdateline matters: Russia, Fiji, Kiribati and the United States
    all straddle 180°, and a ring that crosses it draws as a horizontal
    streak right across the map. The option splits those geometries into
    two parts instead.
    """
    run_ogr([
        "-f", "GeoJSON",
        "-wrapdateline",
        "-simplify", str(simplify),
        "-lco", f"COORDINATE_PRECISION={COORD_PRECISION}",
        "-t_srs", "EPSG:4326",
        out_geojson,
        shp,
    ])


def read_languoids(csv_path: str) -> list[dict]:
    """The languoid table, with the country list split out."""
    if not os.path.exists(csv_path):
        raise SystemExit(f"Source missing: {csv_path}")
    out = []
    with open(csv_path, encoding="utf-8", newline="") as fh:
        for r in csv.DictReader(fh):
            codes = (r.get("country_ids") or "").split()
            if not codes:
                continue
            name = (r.get("name") or "").strip()
            if not name:
                continue
            out.append({
                "id": (r.get("id") or "").strip(),
                "name": name,
                "level": (r.get("level") or "").strip() or "language",
                "iso": (r.get("iso639P3code") or "").strip(),
                "lat": (r.get("latitude") or "").strip(),
                "lng": (r.get("longitude") or "").strip(),
                "countries": codes,
            })
    return out


def read_macroareas(csv_path: str) -> dict:
    """glottocode → macroarea, from the geo export of the same database.

    The languoid table has no macroarea column; this is the only place
    the regions layer gets one.
    """
    if not os.path.exists(csv_path):
        return {}
    out = {}
    with open(csv_path, encoding="utf-8", newline="") as fh:
        for r in csv.DictReader(fh):
            gc = (r.get("glottocode") or "").strip()
            ma = (r.get("macroarea") or "").strip()
            if gc and ma:
                out[gc] = ma
    return out


def display_name(name: str, level: str) -> str:
    """Glottolog's name, with the level suffix taken off.

    The table's own `name` column already reads "Aari language" in some
    dumps and "Aari" in others; the level is published beside it, so the
    suffix is noise in a list of names.
    """
    n = name.strip()
    for suffix in (" language", " dialect"):
        if n.lower().endswith(suffix):
            n = n[: -len(suffix)].strip()
    return n or name.strip()


# ── the regions ─────────────────────────────────────────────────────────

def natural_earth_features(geojson_path: str) -> list[dict]:
    """Read the converted countries, with the join keys resolved."""
    ds = ogr.Open(geojson_path)
    if ds is None:
        raise SystemExit(f"cannot open {geojson_path}")
    lyr = ds.GetLayer(0)
    out = []
    for feat in lyr:
        admin = (feat.GetField("ADMIN") or "").strip()
        # The ADMIN override wins: Natural Earth's ISO_A2 is "-99" for
        # France and Norway, and the "CN-TW" form for Taiwan.
        #
        # ISO_A2_EH is NOT used as a fallback: it is the "extended" code
        # Natural Earth invents for entities that belong to another
        # country — the Indian Ocean Territories and Ashmore and Cartier
        # both carry "AU", so falling back to it would publish AUSTRALIA
        # three times with three different names.
        a2 = NE_A2_OVERRIDE.get(admin, "")
        if not a2:
            a2 = (feat.GetField("ISO_A2") or "").strip()
            if a2 == "-99":
                a2 = ""
        iso_a3 = (feat.GetField("ISO_A3_EH") or "").strip()
        if not iso_a3 or iso_a3 == "-99":
            iso_a3 = (feat.GetField("ISO_A3") or "").strip()
        if iso_a3 == "-99":
            iso_a3 = ""
        m49 = (feat.GetField("ISO_N3_EH") or "").strip()
        if not m49 or m49 == "-99":
            m49 = (feat.GetField("ISO_N3") or "").strip()
        if m49 == "-99":
            m49 = ""
        name = (feat.GetField("NAME_LONG") or "").strip() or admin
        geom = feat.GetGeometryRef()
        if geom is None:
            continue
        # Clone the geometry: the dataset is closed at the end of this
        # function, and a geometry that still points into a freed
        # dataset is a use-after-free — GDAL does not check, it
        # segfaults a few lines later.
        geom = geom.Clone()
        geometry = json.loads(geom.ExportToJson())
        geometry["coordinates"] = round_coords(geometry["coordinates"])
        out.append({
            "admin": admin,
            "name": name,
            "a2": a2,
            "iso_a3": iso_a3,
            "m49": m49,
            "continent": (feat.GetField("CONTINENT") or "").strip(),
            "geometry": geometry,
            "_ogr": geom,
        })
    ds = None
    return out


def find_representative_point(geom_json: dict, ogr_geom) -> tuple:
    """A (lon, lat) point guaranteed to lie INSIDE the polygon.

    OGR's PointOnSurface is the right answer for almost every country,
    but for the few whose outline straddles the antimeridian it can land
    on a boundary, where the ray cast is a coin toss. The fallback scans
    the part centroids and then a coarse grid, and every candidate is
    tested with the SAME ray cast the gate uses — so the published point
    is inside the published rings by construction.
    """
    candidates = []
    try:
        pt = ogr_geom.PointOnSurface()
        candidates.append((pt.GetX(), pt.GetY()))
    except Exception:
        pass
    try:
        c = ogr_geom.Centroid()
        candidates.append((c.GetX(), c.GetY()))
    except Exception:
        pass

    polys = geom_json["coordinates"]
    if geom_json["type"] == "Polygon":
        polys = [polys]
    # Part centroids, largest part first.
    parts = sorted(polys, key=lambda p: -ring_area_deg2(p[0]))
    for poly in parts:
        ring = poly[0]
        if len(ring) < 3:
            continue
        cx = sum(p[0] for p in ring) / len(ring)
        cy = sum(p[1] for p in ring) / len(ring)
        candidates.append((cx, cy))

    for x, y in candidates:
        if not (math.isfinite(x) and math.isfinite(y)):
            continue
        if point_in_geometry(x, y, geom_json):
            return round(x, COORD_PRECISION), round(y, COORD_PRECISION)

    # Last resort: a grid inside the largest part's bounding box.
    if parts:
        ring = parts[0][0]
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        x0, x1 = min(xs), max(xs)
        y0, y1 = min(ys), max(ys)
        steps = 24
        for iy in range(steps + 1):
            y = y0 + (y1 - y0) * iy / steps
            for ix in range(steps + 1):
                x = x0 + (x1 - x0) * ix / steps
                if point_in_geometry(x, y, geom_json):
                    return round(x, COORD_PRECISION), round(y, COORD_PRECISION)
    raise SystemExit("no interior point found for a country polygon")


def build_regions(ne: list[dict], languoids: list[dict],
                  macroareas: dict) -> tuple[list[dict], dict]:
    """One feature per country that has at least one Glottolog language."""
    # country code → languoids spoken there (after the territory aliases)
    by_country: dict[str, list[dict]] = defaultdict(list)
    unmapped: Counter = Counter()
    alias_counts: Counter = Counter()
    for lg in languoids:
        for code in lg["countries"]:
            target = TERRITORY_ALIAS.get(code, code)
            if target != code:
                alias_counts[code] += 1
            by_country[target].append(lg)

    # How many countries each language is listed in — the prominence
    # order the region list uses (English first, then the local ones).
    n_countries = Counter()
    for lg in languoids:
        n_countries[lg["id"]] = len(set(lg["countries"]))

    published_codes = {f["a2"] for f in ne if f["a2"]}

    features = []
    stats = {
        "language_region_pairs": 0,
        "distinct_languages": set(),
        "unmapped": Counter(),
        "aliased": alias_counts,
        # The FULL membership per region — every language, not the capped
        # list that is published. The gate probes against this, so a cap
        # can never hide a broken join from the check.
        "membership": {},
    }
    for f in ne:
        code = f["a2"]
        if not code:
            continue
        langs = by_country.get(code)
        if not langs:
            continue
        # Prominence first (a language spoken in many countries leads),
        # then the level (a language before its dialects), then the name.
        langs = sorted(
            langs,
            key=lambda lg: (-n_countries[lg["id"]],
                            {"language": 0, "dialect": 1}.get(lg["level"], 2),
                            lg["name"]),
        )
        total = len(langs)
        listed = langs[:MAX_LANGUAGES]
        area_counts = Counter()
        for lg in listed:
            ma = macroareas.get(lg["id"], "")
            if ma:
                area_counts[ma] += 1
        macroarea = area_counts.most_common(1)[0][0] if area_counts else ""
        lon, lat = find_representative_point(f["geometry"], f["_ogr"])
        features.append({
            "type": "Feature",
            "properties": {
                "name": f["name"],
                "admin": f["admin"],
                "iso_a3": f["iso_a3"],
                "m49": f["m49"],
                "count": total,
                "languages_total": total,
                "languages_truncated": total > len(listed),
                "languages": [
                    {
                        "name": display_name(lg["name"], lg["level"]),
                        "glottocode": lg["id"],
                        "iso": lg["iso"],
                        "level": lg["level"],
                        "macroarea": macroareas.get(lg["id"], ""),
                    }
                    for lg in listed
                ],
                "macroarea": macroarea,
                "continent": f["continent"],
                "lon": lon,
                "lat": lat,
            },
            "geometry": f["geometry"],
        })
        stats["language_region_pairs"] += total
        for lg in langs:
            stats["distinct_languages"].add(lg["id"])
        stats["membership"][f["name"]] = {
            display_name(lg["name"], lg["level"]) for lg in langs
        }

    # Codes Glottolog uses that no Natural Earth country carries.
    for code, langs in by_country.items():
        if code in published_codes:
            continue
        if code in TERRITORY_ALIAS:
            continue
        stats["unmapped"][code] = len(langs)

    features.sort(key=lambda ft: -ft["properties"]["count"])
    stats["distinct_languages"] = len(stats["distinct_languages"])
    return features, stats


# ── the gate ────────────────────────────────────────────────────────────

def verify(features: list[dict], stats: dict, expected_languages: int) -> None:
    """Gate, not a checkpoint — it refuses to publish a bad file."""
    problems: list[str] = []

    # 1. Every region carries a representative point inside its OWN
    #    polygon. A swapped lon/lat (or a broken point calculation)
    #    fails here, and the axis boxes below catch it a second time.
    bad_points = 0
    for ft in features:
        p = ft["properties"]
        lon, lat = p.get("lon"), p.get("lat")
        if not (isinstance(lon, (int, float)) and isinstance(lat, (int, float))):
            problems.append(f"{p.get('name')}: representative point is not finite")
            bad_points += 1
            continue
        if not (math.isfinite(lon) and math.isfinite(lat)):
            problems.append(f"{p.get('name')}: representative point is not finite")
            bad_points += 1
            continue
        if not point_in_geometry(lon, lat, ft["geometry"]):
            problems.append(
                f"{p.get('name')}: representative point ({lon},{lat}) "
                "is NOT inside its own polygon")
            bad_points += 1
    log(f"  representative point inside its own polygon: "
        f"{len(features) - bad_points}/{len(features)}")

    # 2. The axis check: a region's point must be in the right place on
    #    Earth. A swap puts Ethiopia in the Indian Ocean.
    by_name = {ft["properties"]["name"]: ft for ft in features}
    for name, lon0, lon1, lat0, lat1 in POINT_PROBES:
        ft = by_name.get(name)
        if not ft:
            problems.append(f"probe region {name!r} is missing")
            continue
        lon = ft["properties"]["lon"]
        lat = ft["properties"]["lat"]
        ok = lon0 <= lon <= lon1 and lat0 <= lat <= lat1
        flag = "ok " if ok else "FAIL"
        log(f"  {flag} {name:<22} point ({lon:8.3f},{lat:8.3f}) "
            f"expect lon {lon0}..{lon1}, lat {lat0}..{lat1}")
        if not ok:
            problems.append(
                f"probe {name}: point ({lon},{lat}) is outside the expected box")

    # 3. A known language must land in its known region.
    #
    #    The check runs against the FULL membership (every language of
    #    the region, before the per-region cap), not the capped list
    #    that is published — otherwise a cap could hide a broken join
    #    from the gate. When the membership is not available (the
    #    --verify-only path without the sources) the published list is
    #    used instead, which is weaker but still catches the join.
    membership = stats.get("membership") or {}
    for lang, region in LANGUAGE_PROBES:
        ft = by_name.get(region)
        if not ft:
            problems.append(f"probe region {region!r} is missing")
            continue
        if region in membership:
            names = membership[region]
        else:
            names = {lg["name"] for lg in ft["properties"]["languages"]}
        hit = lang in names
        flag = "ok " if hit else "FAIL"
        log(f"  {flag} {lang:<16} -> {region}")
        if not hit:
            problems.append(
                f"probe language {lang!r} is not spoken in {region!r} "
                f"(it has {ft['properties']['count']} languages)")

    # 3b. …and must NOT land in a country it has nothing to do with.
    for lang, region in NEGATIVE_PROBES:
        ft = by_name.get(region)
        if not ft:
            problems.append(f"probe region {region!r} is missing")
            continue
        if region in membership:
            names = membership[region]
        else:
            names = {lg["name"] for lg in ft["properties"]["languages"]}
        bad = lang in names
        flag = "ok " if not bad else "FAIL"
        log(f"  {flag} {lang:<16} not in {region}")
        if bad:
            problems.append(
                f"probe language {lang!r} is wrongly listed in {region!r}")

    # 4. The region count is plausible.
    n = len(features)
    log(f"  {n} regions")
    if not (150 <= n <= 400):
        problems.append(f"{n} regions (expected a few hundred)")

    # 5. The language count carried by the regions must add up to the
    #    number of languoids that have a country at all.
    pairs = stats["language_region_pairs"]
    distinct = stats["distinct_languages"]
    log(f"  {distinct} distinct languages in {pairs} language-country pairs")
    if distinct < expected_languages - 100:
        problems.append(
            f"only {distinct} distinct languages carried by the regions "
            f"(expected ~{expected_languages})")
    if pairs < expected_languages:
        problems.append(
            f"only {pairs} language-country pairs "
            f"(expected at least {expected_languages})")

    # 6. Every region must carry languages and a count that matches.
    for ft in features:
        p = ft["properties"]
        if not p.get("languages"):
            problems.append(f"{p.get('name')}: no languages listed")
        if p.get("count") != p.get("languages_total"):
            problems.append(f"{p.get('name')}: count != languages_total")
        if p.get("languages_truncated") and len(p["languages"]) > MAX_LANGUAGES:
            problems.append(f"{p.get('name')}: more than {MAX_LANGUAGES} listed")

    # 7. No two regions may share a country code. Natural Earth's
    #    "extended" ISO codes put the Indian Ocean Territories and
    #    Ashmore and Cartier under "AU", which would publish Australia
    #    three times with three different names.
    for key in ("iso_a3", "m49"):
        seen: dict = {}
        for ft in features:
            code = ft["properties"].get(key)
            if not code:
                continue
            if code in seen:
                problems.append(
                    f"{ft['properties']['name']!r} and "
                    f"{seen[code]!r} share {key}={code!r}")
            else:
                seen[code] = ft["properties"]["name"]

    if problems:
        for p in problems:
            log(f"VERIFY FAIL: {p}")
        raise SystemExit("verify() failed — refusing to publish")
    log(f"verify() passed: {n} regions, {distinct} languages, "
        f"{len(LANGUAGE_PROBES)} language probes, "
        f"{len(NEGATIVE_PROBES)} negative probes, "
        f"{len(POINT_PROBES)} axis probes OK")


# ── publish ─────────────────────────────────────────────────────────────

def write_outputs(features: list[dict], stats: dict, out_dir: str,
                  point_meta: dict) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    geo_path = os.path.join(out_dir, "regions.geojson")
    fc = {"type": "FeatureCollection", "features": features}
    with open(geo_path, "w", encoding="utf-8") as fh:
        json.dump(fc, fh, separators=(",", ":"), ensure_ascii=False)
    size = os.path.getsize(geo_path)
    log(f"wrote {geo_path} ({size / 1e6:.2f} MB, {len(features)} regions)")

    counts = [ft["properties"]["count"] for ft in features]
    max_count = max(counts) if counts else 0
    top = [
        {
            "name": ft["properties"]["name"],
            "iso_a3": ft["properties"]["iso_a3"],
            "m49": ft["properties"]["m49"],
            "count": ft["properties"]["count"],
            "macroarea": ft["properties"]["macroarea"],
        }
        for ft in features[:12]
    ]

    regions_meta = {
        "file": "regions.geojson",
        "region_count": len(features),
        "total_regions_with_languages": len(features),
        "attribution": NE_ATTRIBUTION,
        "license": NE_LICENSE,
        "source": NE_URL,
        "glottolog_attribution": ATTRIBUTION,
        "glottolog_license": LICENSE,
        "simplify_deg": SIMPLIFY_DEG,
        "max_languages_listed": MAX_LANGUAGES,
        "max_count": max_count,
        "min_count": min(counts) if counts else 0,
        "language_region_pairs": stats["language_region_pairs"],
        "distinct_languages": stats["distinct_languages"],
        "territory_aliases": TERRITORY_ALIAS,
        "unmapped_country_codes": dict(sorted(stats["unmapped"].items())),
        "top_regions": top,
        "note": (
            "One Natural Earth country polygon per country that has at "
            "least one Glottolog language. The polygon is the COUNTRY, "
            "not the extent of a speech community — Glottolog records "
            "the countries a language is spoken in, never a boundary, so "
            "a language listed for forty countries (English) appears in "
            "forty regions. The per-language territory is the POINTS "
            "layer's job (languages.geojson)."
        ),
    }

    meta = dict(point_meta)
    meta["regions"] = regions_meta
    meta["note"] = (
        point_meta.get("note", "")
        + " The same directory also publishes regions.geojson — one "
        "country polygon per country with Glottolog languages (see the "
        "`regions` block)."
    ).strip()
    meta["disclaimer"] = (
        point_meta.get("disclaimer", "")
        + " The regions product draws a COUNTRY, not the area a language "
        "is spoken in; a country counts every language Glottolog lists "
        "for it, wherever in that country the language is used."
    ).strip()

    meta_path = os.path.join(out_dir, "meta.json")
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2, ensure_ascii=False)
    log(f"wrote {meta_path}")
    return meta


def load_sources(args) -> tuple:
    """Natural Earth features + the Glottolog tables."""
    languoids = read_languoids(args.csv)
    log(f"source {os.path.basename(args.csv)}: "
        f"{len(languoids)} languoids with a country")
    macroareas = read_macroareas(args.geo_csv)
    log(f"macroareas for {len(macroareas)} languoids")

    tmpdir, shp = extract_countries(SRC_ZIP)
    try:
        converted = os.path.join(tmpdir, "_ne50m_simplified.geojson")
        convert_countries(shp, converted, args.simplify)
        ne = natural_earth_features(converted)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    log(f"Natural Earth: {len(ne)} countries")
    return ne, languoids, macroareas


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Build the language-regions overlay")
    ap.add_argument("--out", default=OUT_DIR,
                    help="output directory (default: the published one)")
    ap.add_argument("--csv", default=LANGUID_CSV,
                    help="path to glottolog_languoid.csv")
    ap.add_argument("--geo-csv", default=GEO_CSV,
                    help="path to glottolog_languages_geo.csv (macroareas)")
    ap.add_argument("--simplify", type=float, default=SIMPLIFY_DEG,
                    help="Douglas-Peucker tolerance in degrees")
    ap.add_argument("--verify-only", action="store_true",
                    help="re-run the gate against the published files")
    args = ap.parse_args()

    out_dir = args.out

    if args.verify_only:
        geo_path = os.path.join(out_dir, "regions.geojson")
        meta_path = os.path.join(out_dir, "meta.json")
        if not os.path.exists(geo_path):
            print(f"[lang-regions] missing {geo_path} — run the build first",
                  file=sys.stderr)
            return 1
        with open(geo_path, encoding="utf-8") as fh:
            fc = json.load(fh)
        with open(meta_path, encoding="utf-8") as fh:
            meta = json.load(fh)
        features = fc.get("features", [])
        stats = {
            "language_region_pairs": sum(
                ft["properties"]["count"] for ft in features),
            "distinct_languages": len({
                lg["name"] for ft in features
                for lg in ft["properties"]["languages"]}),
            "unmapped": Counter(
                (meta.get("regions", {}).get("unmapped_country_codes") or {})),
            "aliased": Counter(),
            "membership": {},
        }
        # Rebuild the join from the sources when they are here, so the
        # language probes stay sharp: they check the FULL membership,
        # not the capped list that is published. Without the sources the
        # probes fall back to the published lists.
        try:
            ne, languoids, macroareas = load_sources(args)
            _built, built_stats = build_regions(ne, languoids, macroareas)
            stats["membership"] = built_stats["membership"]
            stats["language_region_pairs"] = built_stats["language_region_pairs"]
            stats["distinct_languages"] = built_stats["distinct_languages"]
        except Exception as exc:  # pragma: no cover - sources may be absent
            log(f"could not rebuild the join from the sources ({exc}); "
                "the language probes will use the published lists")
        verify(features, stats, EXPECTED_LANGUAGES_WITH_COUNTRY)
        print("[lang-regions] verification PASSED")
        return 0

    # The points product's own stats — imported, never re-implemented.
    point_features, point_stats = build_point_product(read_geo_rows(args.geo_csv))
    point_meta = {
        "name": "Languages",
        "source": SOURCE_URL,
        "download": DOWNLOAD_URL,
        "attribution": ATTRIBUTION,
        "license": LICENSE,
        **point_stats,
    }
    # The note/disclaimer are prose about the POINTS product; keep them
    # from the published meta so this script does not fork the wording.
    published_meta_path = os.path.join(out_dir, "meta.json")
    if os.path.exists(published_meta_path):
        try:
            with open(published_meta_path, encoding="utf-8") as fh:
                published = json.load(fh)
            for key in ("note", "disclaimer"):
                if isinstance(published.get(key), str):
                    point_meta[key] = published[key]
        except (ValueError, OSError):
            pass
    log(f"points product: {point_stats['language_count']} languages "
        f"({len(point_features)} features)")

    ne, languoids, macroareas = load_sources(args)
    features, stats = build_regions(ne, languoids, macroareas)
    log(f"{len(features)} regions, "
        f"{stats['language_region_pairs']} language-country pairs, "
        f"{stats['distinct_languages']} distinct languages")
    if stats["unmapped"]:
        log(f"country codes with no Natural Earth country: "
            f"{dict(sorted(stats['unmapped'].items()))}")

    # THE GATE RUNS BEFORE ANYTHING IS WRITTEN.
    verify(features, stats, EXPECTED_LANGUAGES_WITH_COUNTRY)

    write_outputs(features, stats, out_dir, point_meta)
    log("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
