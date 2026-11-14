#!/usr/bin/env python3
"""
Build the world languages overlay for Xyzo.

Source: **Glottolog** — the free, authoritative database of the world's
languages, from the Max Planck Institute for Geoanthropology.
  https://glottolog.org/meta/downloads
  languages_and_dialects_geo.csv   (CC BY-SA 4.0)

The file lists 22,324 languoids (languages + dialects), of which 8,889
carry a coordinate — roughly six times the 1,473 that the previous
Native Land Digital overlay carried, and it includes rare and extinct
languages that the Indigenous-territories dataset does not reach
(Aasax, Wintu, Ainu, Yaghan …).

Output:
  public_html/data/languages/languages.geojson   one Point per language
  public_html/data/languages/meta.json           attribution + counts

The overlay is POINTS, not polygons, on purpose. One polygon per area
can only ever show one language — where several languages share a
territory (as they do across Papua New Guinea, the Amazon and the
Caucasus) the topmost polygon hides the rest. Points overlap, so a
cluster reads as "many languages here" and the probe can list every one
of them under the cursor.

Usage:
  curl -o maps/glottolog_languages_geo.csv \\
    https://cdstar.eva.mpg.de/bitstreams/EAEA0-608B-9919-A962-0/languages_and_dialects_geo.csv
  python3 scripts/languages_build.py
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import Counter

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_CSV = os.path.join(REPO, "maps", "glottolog_languages_geo.csv")
OUT_DIR = os.path.join(REPO, "public_html", "data", "languages")

SOURCE_URL = "https://glottolog.org/meta/downloads"
DOWNLOAD_URL = (
    "https://cdstar.eva.mpg.de/bitstreams/EAEA0-608B-9919-A962-0/"
    "languages_and_dialects_geo.csv"
)
ATTRIBUTION = "Glottolog — Max Planck Institute for Geoanthropology"
LICENSE = "CC BY-SA 4.0"

# (name-substring, iso, lon, lat) — a language and roughly where it is
# spoken. A flipped axis or a broken ISO column puts every one of these
# in the wrong place, and only known languages catch it.
PROBES = [
    ("Basque", "eus", -2.7, 43.1),
    ("Ainu", "ain", 142.6, 42.9),
    ("Aasax", "aas", 36.9, -4.0),
    ("Sámi", "sme", 18.0, 68.5),
    ("Yaghan", "yag", -68.5, -54.9),
    ("Wintu", "wit", -122.5, 41.0),
]


def log(msg: str) -> None:
    print(f"[languages] {msg}", flush=True)


def read_rows(path: str) -> list[dict]:
    with open(path, encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


def build(rows: list[dict]) -> tuple[list[dict], dict]:
    """GeoJSON features + summary stats from the languoid table."""
    features = []
    levels: Counter = Counter()
    areas: Counter = Counter()
    for r in rows:
        lat, lng = r.get("latitude", ""), r.get("longitude", "")
        name = (r.get("name") or "").strip()
        if not lat or not lng or not name:
            continue
        try:
            lat_f, lng_f = float(lat), float(lng)
        except ValueError:
            continue
        if not (-90 <= lat_f <= 90 and -180 <= lng_f <= 180):
            continue
        level = (r.get("level") or "").strip() or "language"
        macroarea = (r.get("macroarea") or "").strip()
        iso = (r.get("isocodes") or "").strip()
        glottocode = (r.get("glottocode") or "").strip()
        levels[level] += 1
        if macroarea:
            areas[macroarea] += 1
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lng_f, lat_f]},
            "properties": {
                "name": name,
                "iso": iso,
                "level": level,
                "macroarea": macroarea,
                "glottocode": glottocode,
            },
        })
    # Several languages sharing a coordinate are the interesting case —
    # the probe lists them all, and the client uses this to draw a
    # stacked dot instead of hiding them under each other.
    by_coord = Counter(
        (f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1])
        for f in features
    )
    for f in features:
        key = tuple(f["geometry"]["coordinates"])
        f["properties"]["colocated"] = by_coord[key]

    stats = {
        "language_count": len(features),
        "levels": dict(levels),
        "macroareas": dict(areas),
        "colocated_coords": sum(1 for n in by_coord.values() if n > 1),
        "max_colocated": max(by_coord.values()) if by_coord else 0,
    }
    return features, stats


def verify(features: list[dict]) -> None:
    """Gate, not a checkpoint: an axis flip still produces a plausible
    count, only known languages in known places catch it."""
    by_iso = {}
    for f in features:
        p = f["properties"]
        for code in (p.get("iso") or "").split():
            by_iso.setdefault(code, f)
    by_name = {f["properties"]["name"].lower(): f for f in features}

    problems = []
    for name, iso, lon, lat in PROBES:
        f = by_iso.get(iso) or by_name.get(name.lower())
        if not f:
            problems.append(f"{name} ({iso}) missing from the output")
            continue
        flat, flng = f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]
        # Glottolog's coordinate is a representative point, so allow a
        # few degrees of slack — we are checking the language, not the
        # exact village.
        ok = abs(flat - lat) < 4 and abs(flng - lon) < 6
        flag = "ok " if ok else "FAIL"
        if not ok:
            problems.append(
                f"{name} at {flat:.1f},{flng:.1f}, expected near {lat},{lon}")
        print(f"[languages]   {flag} {name:<10} ({iso}) -> {flat:.2f},{flng:.2f} "
              f"expect near {lat},{lon}")

    if len(features) < 8000:
        problems.append(f"only {len(features)} languages (expected 8,000+)")
    if problems:
        for p in problems:
            print(f"[languages] VERIFY FAIL: {p}")
        raise SystemExit("verify() failed — refusing to publish")
    log(f"verify() passed: {len(PROBES)} language probes, {len(features)} languages")


def main() -> int:
    ap = argparse.ArgumentParser(description="Build the world languages overlay")
    ap.add_argument("--csv", default=SRC_CSV, help="path to languages_and_dialects_geo.csv")
    args = ap.parse_args()

    if not os.path.exists(args.csv):
        raise SystemExit(
            f"Source missing: {args.csv}\n"
            f"Download it with:  curl -o {args.csv} {DOWNLOAD_URL}"
        )

    rows = read_rows(args.csv)
    log(f"source {os.path.basename(args.csv)}: {len(rows)} languoids")

    features, stats = build(rows)
    log(f"{stats['language_count']} with coordinates "
        f"({stats['levels']})")
    log(f"macroareas: {stats['macroareas']}")
    log(f"coordinates with >1 language: {stats['colocated_coords']} "
        f"(max {stats['max_colocated']} at one point)")

    verify(features)

    os.makedirs(OUT_DIR, exist_ok=True)
    geo_path = os.path.join(OUT_DIR, "languages.geojson")
    fc = {"type": "FeatureCollection", "features": features}
    with open(geo_path, "w", encoding="utf-8") as fh:
        json.dump(fc, fh, separators=(",", ":"), ensure_ascii=False)
    log(f"wrote {geo_path} ({os.path.getsize(geo_path) / 1e6:.2f} MB)")

    meta = {
        "name": "Languages",
        "source": SOURCE_URL,
        "download": DOWNLOAD_URL,
        "attribution": ATTRIBUTION,
        "license": LICENSE,
        **stats,
        "note": (
            "One point per language with a Glottolog coordinate. Points "
            "overlap where several languages are spoken in the same area "
            "(Papua New Guinea, the Amazon, the Caucasus) — the probe "
            "lists every language under the cursor, which a one-polygon-"
            "per-area map cannot do."
        ),
        "disclaimer": (
            "Language locations are Glottolog's representative points "
            "for each language, not the boundaries of a speech community."
        ),
    }
    meta_path = os.path.join(OUT_DIR, "meta.json")
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2, ensure_ascii=False)
    log(f"wrote {meta_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
