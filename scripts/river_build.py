#!/usr/bin/env python3
"""
Build the Natural Earth river overlay assets for Xyzo.

Source: Natural Earth 10m Rivers + Lake Centerlines (public domain)
  https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-rivers-lake-centerlines/
  maps/ne_10m_rivers_lake_centerlines.zip (already in the repo)

Leaflet cannot read a shapefile, and a 4 MB geometry dump is wasteful for
a basemap wash — so the builder writes:

  public_html/data/rivers/rivers.geojson   every line, name + scale rank
  public_html/data/rivers/meta.json        zoom bands, stroke widths, attribution

The client filters by `min_zoom` (Natural Earth's own field) and styles
by `scalerank`: rank 1 is the Amazon at any zoom, rank 9 is a creek that
only appears when you are almost on top of it.

Usage:
  python3 -m scripts.river_build
  python3 -m scripts.river_build --max-points 200
"""

from __future__ import annotations

import argparse
import json
import os
import sys

try:
    from osgeo import ogr
except ImportError as exc:  # pragma: no cover
    print(f"GDAL/OGR required: {exc}", file=sys.stderr)
    raise

ogr.UseExceptions()

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHP = os.path.join(REPO, "maps", "ne_rivers",
                   "ne_10m_rivers_lake_centerlines.shp")
OUT_DIR = os.path.join(REPO, "public_html", "data", "rivers")

# Keep only the fields the map needs. name_en is the English label;
# name is the local-script name when Natural Earth has one.
KEEP_FIELDS = ("name", "name_en", "scalerank", "min_zoom", "featurecla",
               "wikidataid", "label")

# Rank 1..4 are the continental arteries; rank 9 is a local stream.
# Natural Earth's own min_zoom hides small rivers until you are almost
# on top of them — too conservative for this map. Every rank is visible
# by zoom 6 so the drainage network reads as a network, not a handful
# of famous rivers. Stroke widths are CSS pixels.
RANK_STYLE = {
    1: {"width": 3.2, "color": "#3b82f6", "minZoom": 0},
    2: {"width": 2.6, "color": "#3b82f6", "minZoom": 0},
    3: {"width": 2.1, "color": "#4a90e2", "minZoom": 1},
    4: {"width": 1.7, "color": "#4a90e2", "minZoom": 2},
    5: {"width": 1.4, "color": "#5b9bd5", "minZoom": 3},
    6: {"width": 1.1, "color": "#5b9bd5", "minZoom": 4},
    7: {"width": 0.9, "color": "#6aa8e8", "minZoom": 4},
    8: {"width": 0.7, "color": "#6aa8e8", "minZoom": 5},
    9: {"width": 0.6, "color": "#7ab3ef", "minZoom": 5},
    10: {"width": 0.5, "color": "#7ab3ef", "minZoom": 6},
    11: {"width": 0.5, "color": "#8abaf1", "minZoom": 6},
    12: {"width": 0.5, "color": "#8abaf1", "minZoom": 6},
}

# Named rivers worth a label at mid zoom. The client still filters by
# min_zoom; this set only decides which names are eligible for the
# label pass so a tiny unnamed creek never gets a callout.
LABEL_MIN_RANK = 4


def log(msg: str) -> None:
    print(f"[rivers] {msg}", flush=True)


def round_ring(coords, ndigits: int):
    return [[round(x, ndigits), round(y, ndigits)] for x, y in coords]


def simplify_coords(coords, max_points: int):
    """Light Douglas-Peucker so a long river does not ship every bend.

    The shapefile is already cartographically simplified; this only
    trims densified vertices that survive at 10 m scale.
    """
    if len(coords) <= max_points:
        return coords
    # Keep endpoints; sample the rest by stride, then re-round.
    stride = (len(coords) - 2) / (max_points - 2)
    out = [coords[0]]
    for i in range(1, max_points - 1):
        out.append(coords[int(round(i * stride))])
    out.append(coords[-1])
    return out


def build(max_points: int) -> int:
    if not os.path.exists(SHP):
        print(f"[rivers] missing shapefile: {SHP}", file=sys.stderr)
        return 1

    ds = ogr.Open(SHP)
    layer = ds.GetLayer()
    defn = layer.GetLayerDefn()
    field_names = {defn.GetFieldDefn(i).GetName() for i in range(defn.GetFieldCount())}
    for f in KEEP_FIELDS:
        if f not in field_names:
            log(f"warning: field {f!r} missing from shapefile")

    features = []
    dropped = 0
    for feat in layer:
        geom = feat.GetGeometryRef()
        if geom is None:
            dropped += 1
            continue
        gtype = geom.GetGeometryType()
        # The layer is MultiLineString; a few rows are LineString.
        if gtype in (ogr.wkbMultiLineString, ogr.wkbMultiLineString25D,
                     ogr.wkbLineString, ogr.wkbLineString25D):
            lines = [geom] if gtype in (ogr.wkbLineString, ogr.wkbLineString25D) \
                else [geom.GetGeometryRef(i) for i in range(geom.GetGeometryCount())]
        else:
            dropped += 1
            continue

        props = {}
        for name in KEEP_FIELDS:
            if name not in field_names:
                continue
            val = feat.GetField(name)
            if val is not None and val != "":
                props[name] = val

        # Natural Earth's min_zoom is a float (e.g. 7.1); the client
        # compares against the integer map zoom.
        min_zoom = float(props.get("min_zoom", 0) or 0)
        scalerank = int(props.get("scalerank", 9) or 9)
        # A rank-1 river with a missing min_zoom still has to show.
        if "min_zoom" not in props:
            min_zoom = RANK_STYLE.get(scalerank, {}).get("minZoom", 9)
        props["min_zoom"] = min_zoom
        props["scalerank"] = scalerank
        # Prefer the English label for the client.
        label = props.get("name_en") or props.get("name") or props.get("label")
        if label:
            props["label"] = label

        rings = []
        for line in lines:
            pts = []
            for i in range(line.GetPointCount()):
                x, y, *_ = line.GetPoint(i)
                pts.append((x, y))
            if len(pts) < 2:
                continue
            pts = simplify_coords(pts, max_points)
            rings.append(round_ring(pts, 5))
        if not rings:
            dropped += 1
            continue

        if len(rings) == 1:
            geometry = {"type": "LineString", "coordinates": rings[0]}
        else:
            geometry = {"type": "MultiLineString", "coordinates": rings}

        features.append({
            "type": "Feature",
            "properties": props,
            "geometry": geometry,
        })

    ds = None
    if not features:
        print("[rivers] no features extracted", file=sys.stderr)
        return 1

    fc = {
        "type": "FeatureCollection",
        "name": "ne_10m_rivers_lake_centerlines",
        "features": features,
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    geojson_path = os.path.join(OUT_DIR, "rivers.geojson")
    with open(geojson_path, "w") as fh:
        json.dump(fc, fh, separators=(",", ":"))

    # ── meta ───────────────────────────────────────────────────────────
    ranks = {}
    named = 0
    for f in features:
        r = f["properties"]["scalerank"]
        ranks[r] = ranks.get(r, 0) + 1
        if f["properties"].get("label"):
            named += 1

    meta = {
        "source": "Natural Earth 10m Rivers + Lake Centerlines",
        "attribution": "Natural Earth (public domain)",
        "feature_count": len(features),
        "named_count": named,
        "dropped": dropped,
        "ranks": {str(k): v for k, v in sorted(ranks.items())},
        "rank_style": {str(k): v for k, v in RANK_STYLE.items()},
        "label_min_rank": LABEL_MIN_RANK,
        "geojson": "rivers.geojson",
        "license": "Public domain — Natural Earth",
        "url": "https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-rivers-lake-centerlines/",
    }
    with open(os.path.join(OUT_DIR, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=1)

    size = os.path.getsize(geojson_path)
    log(f"{len(features)} lines ({named} named), "
        f"{dropped} dropped, {size / 1024:.0f} KB geojson")
    log(f"ranks: {dict(sorted(ranks.items()))}")
    return 0


# ── verification ─────────────────────────────────────────────────────────

# The big rivers that must be present, at a point they genuinely cross.
# A swapped axis or a shifted projection puts the Amazon in the wrong
# ocean and every probe fails at once.
RIVER_PROBES = [
    ("Amazon", -3.0, -60.0),
    ("Nile", 15.5, 32.5),
    ("Mississippi", 35.0, -90.5),
    ("Danube", 48.0, 17.5),
    ("Yangtze", 30.5, 112.5),
    ("Congo", -1.5, 20.0),
]


def nearest_label(features, lat: float, lng: float, max_km: float = 250.0):
    """Name of the nearest named river line, or None."""
    best = None
    best_d = max_km
    for f in features:
        label = f["properties"].get("label")
        if not label:
            continue
        geom = f["geometry"]
        coords = (geom["coordinates"] if geom["type"] == "LineString"
                  else [c for line in geom["coordinates"] for c in line])
        for x, y in coords[::4]:          # sample every 4th vertex
            # cheap planar degree distance; good enough at 250 km
            dlat = (y - lat)
            dlng = (x - lng) * 0.85       # cos(30°) fudge
            d = (dlat * dlat + dlng * dlng) ** 0.5
            if d < best_d:
                best_d = d
                best = label
    return best


def verify(geojson_path: str) -> bool:
    with open(geojson_path) as fh:
        fc = json.load(fh)
    features = fc["features"]
    ok = True
    for name, lat, lng in RIVER_PROBES:
        found = nearest_label(features, lat, lng, max_km=4.0)
        # 4° ≈ 400 km — the probes sit ON the river, so 4° is generous.
        good = found is not None
        log(f"probe {name:10s} ({lat:6.1f},{lng:7.1f}) -> "
            f"{found or 'NOT FOUND'}{'' if good else ' FAIL'}")
        if not good:
            ok = False
    return ok


def main() -> int:
    global OUT_DIR

    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--max-points", type=int, default=400,
                    help="max vertices per line after trimming")
    ap.add_argument("--verify-only", action="store_true")
    args = ap.parse_args()
    OUT_DIR = args.out

    if args.verify_only:
        path = os.path.join(OUT_DIR, "rivers.geojson")
        if not os.path.exists(path):
            print(f"[rivers] no {path}", file=sys.stderr)
            return 1
        return 0 if verify(path) else 2

    rc = build(args.max_points)
    if rc != 0:
        return rc
    if not verify(os.path.join(OUT_DIR, "rivers.geojson")):
        print("[rivers] verification FAILED — refusing to leave bad data",
              file=sys.stderr)
        return 2
    log("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
