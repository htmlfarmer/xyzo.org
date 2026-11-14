"""Backfill: re-pin stories absorbed by parent metros to their suburbs.

Companion to the live extraction rule (worker/suburb_priority.py). Scans
recent articles placed in large anchor cities, runs the same suburb
refinement on title+body, and moves the placement to the named suburb.

Dry-run by default; --apply to write.

    python3 -m worker.repin_suburbs --days 30 --limit 5000
    python3 -m worker.repin_suburbs --city "Chicago, US" --apply
"""

from __future__ import annotations

import argparse
import logging
import sys
from collections import Counter

from .db import connect
from .geocode import upsert_location
from .suburb_priority import MIN_PARENT_POP, refine, suburb_candidates

log = logging.getLogger("xyzo.repin_suburbs")


def _anchor_locations(days: int) -> list[dict]:
    """news_locations with recent article volume whose names match a big
    world_cities anchor (pop >= MIN_PARENT_POP)."""
    from .cities_text import ALIASES
    from .suburb_priority import MIN_PARENT_POP  # noqa: F401  (documented)
    # our map uses ceremonial/capital names where geonames has the metro
    ANCHOR_ALIASES = {"new delhi": "delhi"}
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT l.id, l.place_name, l.country, l.lat, l.lng, count(a.id) AS arts
            FROM news_locations l
            JOIN news_articles a ON a.location_id = l.id
            WHERE a.published_at > now() - (%s || ' days')::interval
            GROUP BY l.id
            HAVING count(a.id) >= 10
            """,
            (str(days),),
        )
        locs = cur.fetchall()
        anchors: list[dict] = []
        for loc in locs:
            name = loc["place_name"].split(",")[0].strip().lower()
            cc = (loc.get("country") or
                  (loc["place_name"].rsplit(",", 1)[-1] or "").strip().upper()
                  or None)
            names = [name]
            for extra in (ALIASES.get(name), ANCHOR_ALIASES.get(name)):
                if extra and extra.strip().lower() not in names:
                    names.append(extra.strip().lower())
            wc = None
            for nm in names:
                cur.execute(
                    """
                    SELECT id, name, ascii_name, country_code, state_name,
                           lat, lng, population
                    FROM world_cities
                    WHERE lower(name) = %s
                      AND (%s::text IS NULL OR country_code = %s)
                      AND population >= %s
                    ORDER BY population DESC LIMIT 1
                    """,
                    (nm, cc, cc, MIN_PARENT_POP),
                )
                wc = cur.fetchone()
                if wc:
                    break
            if wc:
                anchors.append({**loc, "parent": wc})
        return anchors


def _normalize_place_name(name: str, country_code: str) -> str:
    return f"{name.strip()}, {country_code.strip().upper()}"


def _move_article(cur, article_id: int, suburb_loc_id: int, suburb: dict,
                  label: str) -> None:
    cur.execute(
        """
        UPDATE news_articles
        SET location_id = %s,
            location_text = %s,
            extracted_location = %s,
            extracted_lat = %s,
            extracted_lng = %s,
            location_source = 'suburb_priority',
            location_confidence = GREATEST(COALESCE(location_confidence, 0), 0.9),
            geocoded_at = now()
        WHERE id = %s
        """,
        (suburb_loc_id, label, label, suburb["lat"], suburb["lng"], article_id),
    )


def run(days: int, limit: int, city_filter: str | None, apply: bool,
        batch: int = 200) -> dict:
    stats: Counter[str] = Counter()
    loc_cache: dict[int, int] = {}       # world_cities suburb id -> news_locations id
    cand_cache: dict[int, list[dict]] = {}  # anchor loc id -> candidates

    anchors = _anchor_locations(days)
    if city_filter:
        needle = city_filter.lower().split(",")[0].strip()
        anchors = [a for a in anchors
                   if a["place_name"].lower().split(",")[0].strip().startswith(needle)]
    log.info("anchor locations in scope: %d", len(anchors))

    for anchor in anchors:
        parent = anchor["parent"]
        if parent["id"] not in cand_cache:
            cand_cache[parent["id"]] = suburb_candidates(parent)
        cands = cand_cache[parent["id"]]
        if not cands:
            continue

        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT a.id, a.title, a.body
                FROM news_articles a
                WHERE a.location_id = %s
                  AND a.published_at > now() - (%s || ' days')::interval
                ORDER BY a.published_at DESC
                LIMIT %s
                """,
                (anchor["id"], str(days), max(limit // max(1, len(anchors)) * 4, 200)),
            )
            rows = cur.fetchall()

        moved = 0
        for row in rows:
            if stats["scanned"] >= limit:
                break
            stats["scanned"] += 1
            title = row["title"] or ""
            body = (row["body"] or "")[:3000]
            suburb, why = refine(parent, title, body, candidates=cands)
            if not suburb:
                continue
            label = _normalize_place_name(suburb["name"], suburb["country_code"])
            sid = suburb["id"]
            if sid not in loc_cache:
                if not apply:
                    loc_cache[sid] = -1
                    continue
                loc_cache[sid] = upsert_location({
                    "place_name": label,
                    "place_name_normalized": label.lower(),
                    "country": suburb["country_code"],
                    "lat": suburb["lat"],
                    "lng": suburb["lng"],
                    "precision": "city",
                    "confidence": 0.9,
                    "osm_id": None,
                    "osm_type": None,
                })
            if apply and loc_cache[sid] > 0:
                with connect() as conn, conn.cursor() as cur:
                    _move_article(cur, row["id"], loc_cache[sid], suburb, label)
                    conn.commit()
            moved += 1
            stats[f"pin:{anchor['place_name']}→{label}"] += 1
            log.info("%s article %s: %r → %s (%s)",
                     "MOVED" if apply else "WOULD MOVE",
                     row["id"], title[:60], label, why)

        stats[f"anchor:{anchor['place_name']}"] = moved

    return dict(stats)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--days", type=int, default=14)
    p.add_argument("--limit", type=int, default=20000,
                   help="max articles to scan")
    p.add_argument("--city", help="only this anchor, e.g. 'Chicago, US'")
    p.add_argument("--apply", action="store_true", help="write changes")
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.INFO, stream=sys.stderr,
                        format="%(levelname)s %(name)s: %(message)s")
    stats = run(args.days, args.limit, args.city, args.apply)
    scanned = stats.pop("scanned", 0)
    print(f"\n{'APPLIED' if args.apply else 'DRY RUN'} — scanned {scanned} articles")
    pins = sorted(((k, v) for k, v in stats.items() if k.startswith("pin:")),
                  key=lambda kv: -kv[1])
    for k, v in pins[:40]:
        print(f"  {v:4d}  {k[4:]}")
    moved_total = sum(v for k, v in stats.items() if k.startswith("pin:"))
    print(f"  total re-pins: {moved_total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
