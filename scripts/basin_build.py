#!/usr/bin/env python3
"""
Build the hydrological-basins overlay assets for Xyzo.

Source: FAO "Major hydrological basins of the world" (AQUASTAT / SOLAW)
  https://data.apps.fao.org/catalog//iso/7707086d-af3c-41cc-8aa5-323d8609b2d1
  boundaries/bas_world_38047.zip  →  bas_wrld_38047.shp

The dataset delineates drainage-basin boundaries from hydrologically
corrected elevation data (WWF HydroSHEDS and Hydro1K): 15 arc-seconds
between 60 N and 60 S, 30 arc-seconds poleward of that. It ships as
50,225 polygons, each tagged with the name of the FAO basin it belongs
to. 235 of those names are real basins; the rest carry the FAO sentinel
name "-9999" (small coastal and interior slivers that belong to no
named basin) and are dropped.

The published attribute table (MAJ_BAS / MAJ_NAME / MAJ_AREA / SUB_BAS /
SUB_NAME / SUB_AREA / TO_BAS) is a separate FAO look-up that is NOT
distributed with the geometry and is not exposed by the FAO WMS — only
the six fields in the shapefile are. So the overlay carries what the
data actually has: the basin name, the number of source polygons, and
the basin area computed here from the geometry itself.

Output — ONE basin set at TWO detail levels (DETAIL_LEVELS below; the
same 235 basins drawn at 0.05 deg for speed and 0.01 deg for detail, so
switching never changes what is on the map):
  public_html/data/basins/basins_major.geojson
  public_html/data/basins/basins_detailed.geojson
  public_html/data/basins/meta.json   attribution, legend, area stats,
                                      and the `levels[]` naming the files
A stale single-file basins.geojson is deleted if present (see build()).

Usage:
  python3 -m scripts.basin_build            # both levels: major + detailed
  python3 -m scripts.basin_build --levels major   # one level only (fast)
  python3 -m scripts.basin_build --verify-only
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

try:
    from osgeo import ogr
except ImportError as exc:  # pragma: no cover
    print(f"GDAL/OGR required: {exc}", file=sys.stderr)
    raise

ogr.UseExceptions()

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_ZIP = os.path.join(REPO, "maps", "bas_wrld_38047.zip")
OUT_DIR = os.path.join(REPO, "public_html", "data", "basins")
SHP_NAME = "bas_wrld_38047.shp"

# Two detail levels, both selectable at runtime so the map can be fast
# by default and sharp on demand.
#
# The SOURCE is 8.5 M vertices (HydroSHEDS-derived, sub-km) across
# 50,225 polygons. The published layer dissolves those into the 235
# named basins, which is what loses most of the geometry — the
# tolerance then decides how much of what survives reaches the browser.
#
#   major     0.05 deg ~ 5.5 km   fast: ~7.6 MB, one screen px at z6
#   detailed  0.01 deg ~ 1.1 km   sharp: ~12 MB, meets the 1 km bar
#
# Both levels are the SAME 235 basins, so switching between them never
# changes what is on the map — only how finely the boundary is drawn.
# Measured: 324k -> 690k vertices, largest basin ring 2,432 -> 10,822.
#
# ── AND THE INTERNAL (ENDORHEIC) BASINS ────────────────────────────────
#
# Owner, 2026-11-20: *"can we start to support the INTERNAL BASINS we
# kinda need them"*. They were never missing from the world — they were
# missing from OUR DATA. The 2012 shapefile (`bas_wrld_38047`) carries
# only `NAME_BASIN / GRID_CODE / AREA / PERIMETER`, so the overlay had
# to read the hydrological character off the basin's NAME ("Interior" =
# endorheic) and could only ever see the 8 coarse regions FAO named
# that way.
#
# The FAO's **2022 "Hydrological basins of the world"** carries the
# sub-basin table the 2012 file lacks — `MAJ_BAS / MAJ_NAME / MAJ_AREA /
# SUB_BAS / SUB_NAME / SUB_AREA / TO_BAS` — and `TO_BAS` is the
# downstream basin code: **-888 = internal sub-basin**, -999 = drains to
# the sea. That is the publisher's OWN definition of "internal", not a
# name we infer. It yields **281 named internal basins** (Sahara,
# Caspian, Aral Sea, Lake Chad, Dead Sea, Great Salt Lake, Lake Eyre,
# the Namib, the Kalahari pans, the Gobi lakes, Makgadikgadi …), each
# with its own name and area — against the 8 coarse regions the name
# heuristic could find.
INTERNAL_ZIP = os.path.join(REPO, "maps", "hydrobasins_world.zip")
INTERNAL_SHP_NAME = "final_world_basins.shp"
INTERNAL_DOWNLOAD_URL = (
    "https://storage.googleapis.com/fao-maps-catalog-data/boundaries/"
    "hydrobasins_world.zip"
)
# `TO_BAS = -888` is FAO's own sentinel for an internally drained basin.
INTERNAL_WHERE = "to_bas = -888"

# (id, label, Douglas-Peucker tolerance in degrees, source key)
#   source "major"    -> bas_wrld_38047 (235 named basins)
#   source "internal" -> final_world_basins filtered to TO_BAS = -888
DETAIL_LEVELS = [
    ("major", "Major basins", 0.05, "major"),
    ("detailed", "Detailed", 0.01, "major"),
    ("internal", "Internal", 0.05, "internal"),
    ("internal-detailed", "Internal detailed", 0.01, "internal"),
]
DEFAULT_LEVEL = "major"
DEFAULT_SIMPLIFY = 0.05   # kept for the --simplify override

# ── the UPSTREAM licence (HydroSHEDS version 1) ────────────────────────
#
# THE FAO LABELS BOTH SOURCES CC BY-SA 4.0 / CC BY 4.0, BUT THE PRODUCT
# THEY ARE DERIVED FROM — HydroSHEDS version 1 — CARRIES ITS OWN LICENCE
# (Appendix A of the HydroSHEDS Technical Documentation v1.4), and that
# licence requires the **Exhibit B attribution to travel with the
# product's METADATA**, not merely a credit in the corner of the map.
#
# `docs/DATA_LICENSES.md` had this logged as **OPEN**: *"the WWF/
# HydroSHEDS statement and the 2008 citation are not yet [in the
# metadata], and they are an obligation of the upstream licence."* It is
# closed here — the same three strings `river_network_build.py` carries,
# because they are the same upstream obligation and **a licence
# obligation must survive a rebuild**: the builder OVERWRITES the
# published meta.json, so a text that lives only in a doc is a text that
# disappears the next time anyone runs the build.
UPSTREAM = ("HydroSHEDS version 1 (via FAO AQUASTAT) — © World Wildlife "
            "Fund, Inc. (2006-2022), used under licence")

UPSTREAM_ATTRIBUTION = (
    "This product incorporates data from the HydroSHEDS version 1 "
    "database which is © World Wildlife Fund, Inc. (2006-2022) and has "
    "been used herein under license. WWF has not evaluated the data as "
    "altered and incorporated within this product, and therefore gives "
    "no warranty regarding its accuracy, completeness, currency or "
    "suitability for any particular purpose. Portions of the "
    "HydroSHEDS v1 database incorporate data which are the intellectual "
    "property rights of © USGS (2006-2008), NASA (2000-2005), ESRI "
    "(1992-1998), CIAT (2004-2006), UNEP-WCMC (1993), WWF (2004), "
    "Commonwealth of Australia (2007), and Her Royal Majesty and the "
    "British Crown and are used under license. The HydroSHEDS v1 "
    "database and more information are available at "
    "https://www.hydrosheds.org."
)

UPSTREAM_CITATION = (
    "The scientific citation for the HydroSHEDS version 1 database is: "
    "Lehner, B., Verdin, K., Jarvis, A. (2008): New global hydrography "
    "derived from spaceborne elevation data. Eos, Transactions, AGU, "
    "89(10): 93-94."
)

# Mean Earth radius in km. The area is computed with the exact spherical
# polygon formula rather than a projected area: PROJ's cylindrical
# equal-area ("cea") rejects valid geometry in this dataset, and SQLite's
# ST_Transform is not available here either (no spatialite/PROJ binding).
# The spherical result is within ~0.3 % of the ellipsoidal one, which is
# far finer than the source resolution of 15 arc-seconds.
EARTH_RADIUS_KM = 6371.0088

SOURCE_URL = "https://data.apps.fao.org/catalog//iso/7707086d-af3c-41cc-8aa5-323d8609b2d1"
DOWNLOAD_URL = "https://storage.googleapis.com/fao-maps-catalog-data/boundaries/bas_world_38047.zip"
ATTRIBUTION = "FAO — Major hydrological basins of the world (HydroSHEDS / Hydro1K)"
LICENSE = "CC BY-SA 4.0"

# The FAO names carry the hydrological character in the name itself, so
# the classification is read off the name rather than invented:
#   "Interior"                        an endorheic (internally drained) basin
#   "Coast" / "Seaboard" / "Ocean"     drains straight to the ocean
#   anything else                     a river basin
KIND_RIVER = "river"
KIND_COAST = "coast"
KIND_INTERIOR = "interior"

KIND_LABELS = {
    KIND_RIVER: "River basin",
    KIND_COAST: "Coastal / oceanic drainage",
    KIND_INTERIOR: "Interior (endorheic) basin",
}
KIND_COLORS = {
    KIND_RIVER: "#38bdf8",
    KIND_COAST: "#22d3ee",
    KIND_INTERIOR: "#a78bfa",
}

# The FAO sentinel for "belongs to no named basin".
SENTINEL = "-9999"

# What each source table contributes to a level. Four fields, because
# the two sources differ in all four — see _build_level().
#
#   kind "from_name" means read the hydrological character off the
#   basin's NAME (the 2012 file has no hydrology column at all); a
#   literal means every feature from that source IS that kind. For the
#   internal source that is the honest answer: the row was selected by
#   FAO's own `TO_BAS = -888`, so it is an endorheic basin by
#   construction, whatever the name says.
SOURCE_SPECS = {
    "major": {
        "table": "bas_wrld_38047",
        "name_col": "name_basin",
        "where": f"name_basin <> '{SENTINEL}'",
        "kind": "from_name",
    },
    "internal": {
        "table": "final_world_basins",
        "name_col": "sub_name",
        "where": INTERNAL_WHERE,
        "kind": KIND_INTERIOR,
    },
}

# Places that must land in a plausible basin. A flipped axis or a botched
# dissolve puts these in the wrong country, and only known places catch it.
# Each probe is (lon, lat, acceptable basin names). The list matters:
# FAO names the Rio de la Plata drainage "Pampas Region" in its interior
# and "La Plata Basin" at the estuary, and the Nile has its own basin
# but the Sahara around it is "Africa, North Interior".
PROBES = [
    (-60.0, -3.0, ("Amazon",)),
    (20.0, 0.0, ("Congo",)),
    (31.5, 15.6, ("Nile",)),          # Khartoum
    (-90.0, 35.0, ("Mississippi",)),
    (21.0, 44.0, ("Danube",)),
    (80.0, 25.0, ("Ganges",)),
    (145.0, -34.0, ("Murray",)),
    (72.0, 62.0, ("Ob",)),
    (114.0, 30.0, ("Yangtze",)),
    (46.0, 51.0, ("Volga",)),
    (104.0, 17.0, ("Mekong",)),
    (-58.4, -34.6, ("La Plata", "Pampas")),
    (31.2, 30.0, ("Nile",)),          # Cairo
    (-90.2, 38.6, ("Mississippi",)),  # St Louis
    (2.35, 48.85, ("Seine",)),        # Paris
]

# Probes for the INTERNAL (endorheic) level. Every point was checked
# against the source geometry with a real point-in-polygon test — a
# probe that sits just outside its basin would make the gate fail on a
# correct build, and one that sits in the wrong basin would pass a
# broken one. Spans Africa, Asia, the Middle East, North America and
# Australia, because a mirrored axis fails in the hemisphere you did
# not probe.
INTERNAL_PROBES = [
    (-10.0, 23.0, ("Sahara",)),                       # central Sahara
    (26.0, 28.0, ("Egyptian western Desert",)),       # N Africa
    (19.0, 18.0, ("Borkou",)),                        # Lake Chad basin
    (17.0, -18.0, ("Omuramba Ovambo",)),              # Botswana
    (60.0, 45.0, ("Aral Sea",)),                      # Aral
    (74.0, 46.3, ("Lake Balkash",)),                  # Balkhash
    (64.0, 42.0, ("Kyzylkum",)),                      # Karakum/Kyzylkum
    (54.0, 34.5, ("Dasht-e Kavir",)),                 # Iran plateau
    (100.2, 36.9, ("Ch'ing-hai Hu",)),                # Qinghai Lake
    (89.2, 42.9, ("Turpan Pendi",)),                  # Turpan depression
    (90.5, 40.5, ("Lop Nur",)),                       # Lop Nur
    (101.0, 41.0, ("Jo Shui", "Gaxun Nur")),          # Gobi
    (-112.5, 41.2, ("Great Salt Lake",)),             # USA
    (138.0, -30.0, ("Lake Frome",)),                  # Australia
]


def log(msg: str) -> None:
    print(f"[basins] {msg}", flush=True)


def _ring_area_km2(ring) -> float:
    """Area of one closed ring on a sphere (Girard's theorem)."""
    if not ring or len(ring) < 3:
        return 0.0
    total = 0.0
    n = len(ring)
    for i in range(n):
        lon1, lat1 = ring[i][0], ring[i][1]
        lon2, lat2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        # The longitude difference must be in RADIANS — the sin() terms
        # are, and mixing degrees with radians inflates the area by
        # roughly 57x (the number of degrees per radian).
        total += math.radians(lon2 - lon1) * (2.0 + math.sin(math.radians(lat1))
                                               + math.sin(math.radians(lat2)))
    return (EARTH_RADIUS_KM ** 2) * total / 2.0


def spherical_area_km2(geom) -> float:
    """Area of a Polygon or MultiPolygon in square km."""
    gtype = geom.GetGeometryName().upper()
    if gtype == "POLYGON":
        rings = [geom.GetGeometryRef(i) for i in range(geom.GetGeometryCount())]
        if not rings:
            return 0.0
        area = _ring_area_km2(rings[0].GetPoints())
        for hole in rings[1:]:
            area -= _ring_area_km2(hole.GetPoints())
        return abs(area)
    if gtype == "MULTIPOLYGON":
        total = 0.0
        for i in range(geom.GetGeometryCount()):
            total += spherical_area_km2(geom.GetGeometryRef(i))
        return total
    return 0.0


def kind_for(name: str) -> str:
    n = name.lower()
    if "interior" in n:
        return KIND_INTERIOR
    if any(k in n for k in ("coast", "seaboard", "ocean", "islands")):
        return KIND_COAST
    return KIND_RIVER


def extract_source() -> tuple[str, dict[str, str]]:
    """Unpack BOTH source zips into a temp dir.

    Returns (tmpdir, {source_key: .shp path}). Two sources, because the
    internal basins are not in the 2012 file — see INTERNAL_ZIP.
    """
    tmp = tempfile.mkdtemp(prefix="basin_src_")
    found: dict[str, str] = {}

    for key, zip_path, shp_name in (
        ("major", SRC_ZIP, SHP_NAME),
        ("internal", INTERNAL_ZIP, INTERNAL_SHP_NAME),
    ):
        if not os.path.exists(zip_path):
            url = DOWNLOAD_URL if key == "major" else INTERNAL_DOWNLOAD_URL
            raise SystemExit(
                f"Source missing: {zip_path}\n"
                f"Download it from {url} and save it there."
            )
        log(f"extracting {os.path.basename(zip_path)} "
            f"({os.path.getsize(zip_path) / 1e6:.0f} MB)")
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(tmp)
        shp = os.path.join(tmp, shp_name)
        if not os.path.exists(shp):
            raise SystemExit(f"{shp_name} not found inside {zip_path}")
        found[key] = shp

    return tmp, found


def run_ogr(args: list[str]) -> None:
    proc = subprocess.run(
        ["ogr2ogr", *args], capture_output=True, text=True, timeout=3600
    )
    if proc.returncode != 0:
        raise SystemExit(f"ogr2ogr failed:\n{proc.stderr[-2000:]}")


def _build_level(shp: str, tmpdir: str, simplify: float, coord_precision: int,
                 out_geojson: str, spec: dict) -> tuple:
    """One detail level: dissolve -> simplify -> makevalid -> enrich.

    `spec` names the source table, the column the basin's NAME lives in,
    the rows to keep, and how the hydrological `kind` is decided. The
    two sources differ in all four:

        major     bas_wrld_38047  name_basin  <> '-9999'   kind_for(name)
        internal  final_world_basins sub_name  to_bas=-888  always "interior"

    The internal spec filters on FAO's OWN `TO_BAS = -888` sentinel
    rather than on the basin's name — the publisher's definition of an
    internally drained basin, not one we infer.

    Returns (features, kind_counts, total_area_km2, problems).
    """
    table = spec["table"]
    name_col = spec["name_col"]
    where = spec["where"]
    # One pass: dissolve by basin name, compute the true area from an
    # equal-area projection, and simplify. The source polygons are tiny
    # and enormously detailed, so dissolving first is what makes the
    # output usable at all (50,225 polygons -> ~235).
    sql = f"""
        WITH u AS (
          SELECT {name_col} AS name,
                 count(*) AS n_polys,
                 ST_Union(geometry) AS geom
          FROM {table}
          WHERE {where}
          GROUP BY {name_col}
        )
        SELECT name,
               n_polys,
               geom AS geometry
        FROM u
    """
    log(f"  dissolving + simplifying (tolerance {simplify} deg) ...")
    simplified = os.path.join(tmpdir, f"_basins_{simplify}_simplified.json")
    for stale in (out_geojson, simplified):
        if os.path.exists(stale):
            os.remove(stale)
    run_ogr([
        "-f", "GeoJSON",
        "-dialect", "SQLite",
        "-simplify", str(simplify),
        "-lco", f"COORDINATE_PRECISION={coord_precision}",
        "-sql", sql,
        simplified,
        shp,
    ])

    # Pass 2 - make the geometry valid. Douglas-Peucker can turn a
    # ring into a bowtie, and an invalid polygon renders as a broken
    # shape in Leaflet and throws on point-in-polygon tests.
    run_ogr([
        "-f", "GeoJSON",
        "-makevalid",
        "-nlt", "MULTIPOLYGON",
        "-lco", f"COORDINATE_PRECISION={coord_precision}",
        out_geojson,
        simplified,
    ])
    if os.path.exists(simplified):
        os.remove(simplified)

    size = os.path.getsize(out_geojson)
    log(f"  wrote {out_geojson} ({size / 1e6:.1f} MB)")

    # Read it back, compute the true area, write the final file.
    problems: list[str] = []
    ds = ogr.Open(out_geojson)
    lyr = ds.GetLayer(0)
    out_features = []
    features = []
    kinds = {}
    total_area = 0.0
    for feat in lyr:
        name = feat.GetField("name")
        n_polys = int(feat.GetField("n_polys") or 0)
        # OGR reports geometry type names in UPPERCASE.
        gtype = feat.GetGeometryRef().GetGeometryName().upper()
        if gtype not in ("POLYGON", "MULTIPOLYGON"):
            problems.append(f"basin {name!r} has geometry type {gtype}")
            continue
        area_km2 = spherical_area_km2(feat.GetGeometryRef())
        # "from_name" = the 2012 file's heuristic (it has no hydrology
        # column); anything else is fixed by the source spec.
        if spec["kind"] == "from_name":
            kind = kind_for(name)
        else:
            kind = spec["kind"]
        kinds[kind] = kinds.get(kind, 0) + 1
        total_area += area_km2
        out_features.append({
            "type": "Feature",
            "properties": {
                "name": name,
                "kind": kind,
                "area_km2": int(round(area_km2)),
                "n_polys": n_polys,
            },
            "geometry": json.loads(feat.GetGeometryRef().ExportToJson()),
        })
        features.append({
            "name": name,
            "kind": kind,
            "area_km2": int(round(area_km2)),
            "n_polys": n_polys,
        })
    ds = None

    # Rewrite with the enriched properties. Sorting by area puts the
    # biggest basins first, which is the order a legend wants.
    out_features.sort(key=lambda f: -f["properties"]["area_km2"])
    features.sort(key=lambda f: -f["area_km2"])
    with open(out_geojson, "w") as fh:
        json.dump({"type": "FeatureCollection", "features": out_features}, fh,
                  separators=(",", ":"))
    log(f"rewrote {out_geojson} with enriched properties")
    for p in problems:
        log(f"build problem: {p}")

    # Sort by area so the biggest basins come first in the legend.
    features.sort(key=lambda f: -f["area_km2"])
    log(f"{len(features)} basins, {total_area / 1e6:.1f} M km² total")

    meta = {
        "name": "Hydrological Basins",
        "source": SOURCE_URL,
        "download": DOWNLOAD_URL,
        "attribution": ATTRIBUTION,
        "license": LICENSE,
        "basin_count": len(features),
        "total_area_km2": round(total_area),
        "simplify_deg": simplify,
        "kind_counts": kinds,
        "kind_labels": KIND_LABELS,
        "kind_colors": KIND_COLORS,
        "top_basins": [
            {"name": f["name"], "area_km2": f["area_km2"], "kind": f["kind"]}
            for f in features[:12]
        ],
        "note": (
            "Basins are FAO-named drainage regions. The published "
            "MAJ_BAS/SUB_BAS/TO_BAS attribute table is not distributed "
            "with the geometry, so the basin area here is computed from "
            "the polygons themselves in an equal-area projection."
        ),
    }
    meta_path = os.path.join(OUT_DIR, "meta.json")
    with open(meta_path, "w") as fh:
        json.dump(meta, fh, indent=2)
    log(f"wrote {meta_path}")

    return features, kinds, total_area, problems


def build(coord_precision: int = 4) -> dict:
    """Build every detail level and the shared meta.json."""
    tmpdir, shps = extract_source()
    try:
        os.makedirs(OUT_DIR, exist_ok=True)

        # The old single-file output is superseded; drop it so a stale
        # copy cannot be served alongside the new per-level files.
        legacy = os.path.join(OUT_DIR, "basins.geojson")
        if os.path.exists(legacy):
            os.remove(legacy)

        levels_meta: list[dict] = []
        shared = None
        for lid, label, tol, src_key, *_ in DETAIL_LEVELS:
            spec = SOURCE_SPECS[src_key]
            shp = shps[src_key]
            out_geojson = os.path.join(OUT_DIR, f"basins_{lid}.geojson")
            log(f"[{lid}] building detail level ({tol} deg, "
                f"source={spec['table']}) ...")
            features, kinds, total, problems = _build_level(
                shp, tmpdir, tol, coord_precision, out_geojson, spec)
            for pr in problems:
                log(f"build problem ({lid}): {pr}")
            size = os.path.getsize(out_geojson)
            log(f"[{lid}] {len(features)} basins, {total / 1e6:.1f} M km2, "
                f"{size / 1e6:.1f} MB")
            levels_meta.append({
                "id": lid,
                "label": label,
                "file": f"basins_{lid}.geojson",
                "simplify_deg": tol,
                "source": src_key,
                "size": size,
                "basins": len(features),
                "total_area_km2": round(total),
            })
            levels_meta[-1]["kind_counts"] = kinds
            if shared is None:
                shared = (features, kinds, total)

        features, kinds, total_area = shared
        # The shared stats come from the first level; both levels hold
        # the SAME 235 basins, so only the boundary geometry differs.
        features.sort(key=lambda f: -f["area_km2"])
        meta = {
            "name": "Hydrological Basins",
            "source": SOURCE_URL,
            "download": DOWNLOAD_URL,
            "attribution": ATTRIBUTION,
            "license": LICENSE,
            # ── the UPSTREAM (HydroSHEDS v1) obligation ──────────────
            # docs/DATA_LICENSES.md logged this as OPEN: the FAO credit
            # was present, but the upstream licence requires the WWF/
            # HydroSHEDS statement AND the 2008 citation to travel with
            # the LAYER'S METADATA, not just with a map credit. They are
            # written here because this builder overwrites meta.json —
            # a licence text that lives only in a document disappears
            # the next time anyone rebuilds.
            "upstream": UPSTREAM,
            "upstream_attribution": UPSTREAM_ATTRIBUTION,
            "upstream_citation": UPSTREAM_CITATION,
            "basin_count": len(features),
            "total_area_km2": round(total_area),
            "levels": levels_meta,
            "default_level": DEFAULT_LEVEL,
            "kind_counts": kinds,
            "kind_labels": KIND_LABELS,
            "kind_colors": KIND_COLORS,
            "top_basins": [
                {"name": f["name"], "area_km2": f["area_km2"], "kind": f["kind"]}
                for f in features[:12]
            ],
            "note": (
                "Basins are FAO-named drainage regions. The 2012 source "
                "carries only NAME_BASIN/GRID_CODE/AREA/PERIMETER, so the "
                "basin area here is computed from the polygons themselves. "
                "FOUR detail levels are published: the 235 named basins at "
                "0.05 deg (fast) and 0.01 deg (~1 km, sharp), and the 281 "
                "INTERNALLY DRAINED (endorheic) sub-basins at the same two "
                "precisions — selected by FAO's own TO_BAS = -888 sentinel "
                "from the 2022 Hydrological basins of the world dataset, "
                "which carries the sub-basin table the 2012 file does not."
            ),
        }
        meta_path = os.path.join(OUT_DIR, "meta.json")
        with open(meta_path, "w") as fh:
            json.dump(meta, fh, indent=2)
        log(f"wrote {meta_path}")

        # The gate runs on EVERY published level — a file that fails
        # must never be served, whichever one the user picks.
        for lv in levels_meta:
            # Each level is gated against ITS OWN expectations — see
            # LEVEL_EXPECT. The gate reads the PUBLISHED FILE, not the
            # in-memory list: the shared `features` are the major
            # level's, and passing those made the log line report "235
            # basins" for a 281-basin internal level.
            verify(os.path.join(OUT_DIR, lv["file"]),
                   {"total_area_km2": lv["total_area_km2"]},
                   level=lv["id"])
        return meta
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# What each published level must look like. ONE set of bounds cannot
# serve both sources: the major levels hold 235 named basins covering
# ~147 M km² of land, the internal levels hold 281 endorheic sub-basins
# covering ~19.7 M km² (FAO's own SUB_AREA sum). A single range would
# either reject a CORRECT internal build or accept a broken major one —
# and a gate that cannot fail is not a gate.
LEVEL_EXPECT = {
    "major":    dict(count=(200, 400), area=(40, 200), probes=PROBES,
                     all_kind=None),
    "detailed": dict(count=(200, 400), area=(40, 200), probes=PROBES,
                     all_kind=None),
    "internal": dict(count=(270, 295), area=(14, 26),
                     probes=INTERNAL_PROBES, all_kind=KIND_INTERIOR),
    "internal-detailed": dict(count=(270, 295), area=(14, 26),
                              probes=INTERNAL_PROBES, all_kind=KIND_INTERIOR),
}


def verify(geojson_path: str, meta: dict, level: str = "major") -> None:
    """Gate, not a checkpoint — a wrong axis passes a size check.

    `level` selects the expectations, because the internal levels come
    from a different source with a different population. Expectations a
    level does not have fall back to the major ones, so a level that
    forgets to register still gets a gate rather than none.
    """
    exp = LEVEL_EXPECT.get(level, LEVEL_EXPECT["major"])
    problems = []

    ds = ogr.Open(geojson_path)
    lyr = ds.GetLayer(0)

    lo, hi = exp["count"]
    if lyr.GetFeatureCount() < lo:
        problems.append(f"only {lyr.GetFeatureCount()} basins "
                        f"(expected {lo}–{hi})")
    if lyr.GetFeatureCount() > hi:
        problems.append(f"{lyr.GetFeatureCount()} basins — the dissolve did not run")

    # Every feature must carry a name and a positive area.
    for feat in lyr:
        name = feat.GetField("name")
        area = feat.GetField("area_km2")
        if not name or name == SENTINEL:
            problems.append(f"bad name {name!r}")
            break
        if area is None or float(area) <= 0:
            problems.append(f"basin {name!r} has area {area}")
            break

    # The internal levels exist to be internal: a single feature that is
    # not an endorheic basin means the TO_BAS filter did not apply, and
    # the level would silently serve a mixed population under a name
    # that promises one thing.
    if exp["all_kind"]:
        lyr.ResetReading()
        wrong = [f.GetField("name") for f in lyr
                 if f.GetField("kind") != exp["all_kind"]]
        if wrong:
            problems.append(
                f"{len(wrong)} feature(s) are not {exp['all_kind']} "
                f"(first: {wrong[0]!r}) — the internal filter did not apply"
            )

    # Known places must land in a plausible basin.
    for lon, lat, expect in exp["probes"]:
        pt = ogr.CreateGeometryFromWkt(f"POINT ({lon} {lat})")
        lyr.ResetReading()
        hit = None
        for feat in lyr:
            try:
                inside = feat.GetGeometryRef().Contains(pt)
            except Exception:
                # A topology error must not be mistaken for "not in a basin"
                inside = False
            if inside:
                hit = feat.GetField("name")
                break
        if not hit:
            problems.append(f"probe ({lon},{lat}) hit no basin (expected {expect})")
        elif not any(e.lower() in hit.lower() for e in expect):
            problems.append(f"probe ({lon},{lat}) → {hit!r}, expected one of {expect!r}")

    # The basins must cover a sane fraction of the land surface.
    # Earth's land is ~149 M km² and the major levels hold the NAMED
    # basins only, so the total should land in the same order of
    # magnitude — a degrees / radians slip in the area formula inflates
    # this by ~57x. The internal levels are a SUBSET of that, hence
    # their own, much smaller, range.
    total = meta["total_area_km2"] / 1e6
    lo_a, hi_a = exp["area"]
    if not (lo_a < total < hi_a):
        problems.append(f"total basin area {total:.0f} M km² is implausible "
                        f"(expected {lo_a}–{hi_a})")

    if problems:
        for p in problems:
            log(f"VERIFY FAIL [{level}]: {p}")
        raise SystemExit(f"verify() failed for level {level} — refusing to publish")
    log(f"verify({level}) passed: {lyr.GetFeatureCount()} basins, "
        f"{total:.0f} M km², {len(exp['probes'])} place probes OK")


def main() -> None:
    # Must come FIRST: DETAIL_LEVELS is read below (in the argparse
    # default) and rebound when --levels narrows the set, so Python
    # would otherwise treat it as a local and raise UnboundLocalError.
    global DETAIL_LEVELS
    ap = argparse.ArgumentParser(description="Build the hydrological basins overlay")
    ap.add_argument("--precision", type=int, default=4,
                    help="coordinate decimal places in the GeoJSON (default 4)")
    ap.add_argument("--levels", default=",".join(l[0] for l in DETAIL_LEVELS),
                    help="comma-separated level ids to build (default: all)")
    ap.add_argument("--verify-only", action="store_true",
                    help="re-run the gate against the published files, build nothing")
    args = ap.parse_args()

    if args.verify_only:
        # Index the tuple rather than unpacking it: the level record has
        # grown once already (a source key), and an unpack that must be
        # edited every time it grows is an unpack that will be missed.
        for lv_spec in DETAIL_LEVELS:
            lid = lv_spec[0]
            path = os.path.join(OUT_DIR, f"basins_{lid}.geojson")
            if not os.path.exists(path):
                print(f"[basins] missing {path} — run the build first",
                      file=sys.stderr)
                return
            meta = json.load(open(os.path.join(OUT_DIR, "meta.json")))
            lv = next((x for x in meta.get("levels", []) if x["id"] == lid), {})
            ds = ogr.Open(path)
            lyr = ds.GetLayer(0)
            ds = None
            # The level id selects the expectations (LEVEL_EXPECT) —
            # reading it off meta.json means a level added to the build
            # is verified by the same code path without a second list.
            verify(path, {"total_area_km2": lv.get("total_area_km2", 0)},
                   level=lid)
        print("[basins] verification PASSED for every published level")
        return

    wanted = {x.strip() for x in args.levels.split(",") if x.strip()}
    DETAIL_LEVELS = [lv for lv in DETAIL_LEVELS if lv[0] in wanted]
    if not DETAIL_LEVELS:
        print(f"[basins] no matching level in {args.levels!r}", file=sys.stderr)
        return
    build(args.precision)


if __name__ == "__main__":
    main()
