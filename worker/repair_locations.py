#!/usr/bin/env python3
"""Repair the `news_locations` table: duplicate rows and wrong coordinates.

THE BUG
-------
`news_locations` accumulated thousands of duplicate rows for the same
place, and — worse — rows whose LABEL does not match their COORDINATES.
Label and coordinates come from two different gazetteers and were copied
by id, and ids collide between `news_locations` and `world_cities`:

    id 379  "Wollongong, AU"  at (-33.868, 151.207) = Sydney
    id 775  "Abuja, NG"       at ( 6.454,   3.395) = Lagos
    id 2229 "Belfast, GB"     at (51.507,  -0.128) = London
    id 1493 "Rabat, MA"       at (33.588,  -7.611) = Casablanca
    id 1556 "Mazār-e Sharīf"  at (34.528,  69.172) = Kabul
    id 1980 "Vancouver, CA"   at (43.706, -79.399) = Toronto

The map renders the LABEL, so 25k stories about Lagos were shown as
"Abuja, NG" and 11.5k stories about London as "Belfast, GB". Duplicate
rows for one city also split its story count across several pins — the
"103 Stories in Bamako, ML" the map showed for one 24 h window was
100 + 3 from two different `Bamako, ML` rows.

REPAIRS
-------
  1. rows whose coordinates disagree with their label are corrected:
     the label wins when it names a known city, the coordinates win when
     the label is garbage ("Ho, GT" holding Guatemala City's position);
  2. rows that describe the same place are merged into one canonical row;
  3. the 'Test City' rows the test suite left behind are removed.

USAGE
-----
    python -m worker.repair_locations --dry-run
    python -m worker.repair_locations --apply
"""

from __future__ import annotations

import argparse
import logging
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# No credentials in the repo: export XYZO_DB_DSN (or set PGPASSWORD)
# before running. The default matches worker/tests/conftest.py.
os.environ.setdefault("XYZO_DB_DSN", "postgresql://xyzo_app@localhost:5432/xyzo")

from worker.db import connect

log = logging.getLogger("xyzo.repair_locations")

# "City, CC" — the simple form we can verify against world_cities.
# Anything else (addresses, landmarks) is left alone.
SIMPLE_NAME_RE = re.compile(r"^[^,]+,\s*[A-Z]{2}$")
# How far a label and its coordinates may disagree before we call one of
# them wrong (~5 km at the equator).
COORD_TOLERANCE_DEG = 0.05

FK_SKIP = {"news_locations"}


def _referencing_columns(cur) -> list[tuple[str, str]]:
    """(table, column) pairs that reference news_locations(id)."""
    cur.execute("""
        SELECT con.conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint con
        JOIN pg_attribute a
          ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
        WHERE con.contype = 'f'
          AND con.confrelid = 'news_locations'::regclass
    """)
    return [(r["tbl"], r["col"]) for r in cur.fetchall()]


def _repoint(cur, mapping: dict[int, int], refs: list[tuple[str, str]]) -> int:
    """Move every reference from an old location id to its canonical id."""
    if not mapping:
        return 0
    cur.execute("""
        CREATE TEMP TABLE IF NOT EXISTS loc_remap (old_id bigint PRIMARY KEY, new_id bigint)
    """)
    cur.execute("TRUNCATE loc_remap")
    cur.executemany(
        "INSERT INTO loc_remap (old_id, new_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
        list(mapping.items()),
    )
    # Without this the planner seq-scans the 9.6 GB table instead of using
    # news_articles_location_idx.
    cur.execute("SET LOCAL enable_seqscan = off")
    moved = 0
    for tbl, col in refs:
        if tbl in FK_SKIP:
            continue
        cur.execute(
            f'UPDATE "{tbl}" t SET "{col}" = r.new_id '
            f'FROM loc_remap r WHERE t."{col}" = r.old_id'
        )
        moved += cur.rowcount
    cur.execute("SET LOCAL enable_seqscan = on")
    cur.execute("DROP TABLE loc_remap")
    return moved


def _article_counts(cur) -> dict[int, int]:
    cur.execute("""
        SELECT location_id, COUNT(*)::int AS n
        FROM news_articles WHERE location_id IS NOT NULL GROUP BY 1
    """)
    return {r["location_id"]: r["n"] for r in cur.fetchall()}


def _city_coords(cur) -> dict[tuple[str, str], tuple[float, float]]:
    """(city name, ISO country) → (lat, lng) from world_cities."""
    cur.execute("""
        SELECT id, name, country_code, lat, lng
        FROM world_cities
        WHERE name IS NOT NULL AND country_code IS NOT NULL
        ORDER BY id
    """)
    out: dict[tuple[str, str], tuple[float, float]] = {}
    for r in cur.fetchall():
        out.setdefault((r["name"].strip(), r["country_code"].strip()), (r["lat"], r["lng"]))
    return out


def _city_at_coords(cur) -> list[dict]:
    """world_cities rows we can use to fix a garbage label."""
    cur.execute("""
        SELECT id, name, country_code, lat, lng
        FROM world_cities
        WHERE name IS NOT NULL AND country_code IS NOT NULL
        ORDER BY id
    """)
    return [dict(r) for r in cur.fetchall()]


def _close(lat1, lng1, lat2, lng2, tol=COORD_TOLERANCE_DEG) -> bool:
    return abs(lat1 - lat2) <= tol and abs(lng1 - lng2) <= tol


def _parse_place(text: str, fallback_cc: str | None) -> tuple[str, str] | None:
    """Split a place string into (city, ISO country).

    Handles "Lagos, NG", "Mumbai Metropolitan Region, IN, IN" and
    "Unknown, Jalan Raya ..., Indonesia" (the last part is a country
    name, not a code — those are skipped).
    """
    if not text:
        return None
    parts = [p.strip() for p in text.split(",") if p.strip()]
    if not parts:
        return None
    city = parts[0]
    cc = None
    for p in reversed(parts[1:]):
        if len(p) == 2 and p.isalpha() and p.isupper():
            cc = p
            break
    if not cc:
        cc = (fallback_cc or "").strip().upper() or None
    if not cc or len(city) < 2:
        return None
    return city, cc


def _majority_place_texts(cur, days: int = 120) -> dict[int, tuple[str, int]]:
    """The place each location row's articles actually name.

    `news_articles.location_text` is what the pipeline resolved for the
    article. The row's own `place_name` is only the label a gazetteer
    lookup produced — and the two disagree whenever a row was copied by
    id. The articles are the ground truth: 25k stories whose text said
    "Lagos, NG" were pinned on a row labelled "Abuja, NG".
    """
    cur.execute("""
        SELECT location_id, location_text, COUNT(*)::int AS n
        FROM news_articles
        WHERE location_id IS NOT NULL
          AND location_text IS NOT NULL
          AND location_text <> ''
          AND published_at > now() - (%s || ' days')::interval
        GROUP BY 1, 2
    """, (days,))
    best: dict[int, tuple[str, int]] = {}
    for r in cur.fetchall():
        cur_id = r["location_id"]
        if cur_id not in best or r["n"] > best[cur_id][1]:
            best[cur_id] = (r["location_text"], r["n"])
    return best


def plan(cur) -> dict:
    """Build the repair plan. Touches nothing."""
    refs = _referencing_columns(cur)
    counts = _article_counts(cur)
    by_name_coords = _city_coords(cur)

    cur.execute("""
        SELECT id, place_name, place_name_normalized, country, lat, lng
        FROM news_locations
    """)
    rows = [dict(r) for r in cur.fetchall()]

    def label_coords(r: dict):
        """The coordinates the label names, if the label names a real city."""
        name = (r["place_name"] or "").strip()
        if not SIMPLE_NAME_RE.match(name):
            return None
        return by_name_coords.get((name.split(",")[0].strip(), (r["country"] or "").strip()))

    def coords_ok(r: dict) -> bool:
        target = label_coords(r)
        if not target:
            return True        # not verifiable — assume fine
        return _close(r["lat"], r["lng"], target[0], target[1])

    for r in rows:
        r["_coords_ok"] = coords_ok(r)

    # index of rows by (normalised name, rounded coords) — the unique key
    key_index: dict[tuple[str, float, float], int] = {}
    for r in rows:
        key_index.setdefault(
            (r["place_name_normalized"], round(r["lat"], 3), round(r["lng"], 3)), r["id"])

    by_name: dict[str, list[dict]] = {}
    for r in rows:
        by_name.setdefault(r["place_name_normalized"], []).append(r)

    merges: dict[int, int] = {}     # old_id → new_id (row is deleted)
    coord_moves: list[tuple[int, float, float]] = []
    label_moves: list[tuple[int, str, str]] = []

    # The place each row's articles actually name — the ground truth.
    majority = _majority_place_texts(cur)

    for norm, group in by_name.items():
        canonical = max(group, key=lambda r: (
            1 if r["_coords_ok"] else 0, counts.get(r["id"], 0), -r["id"]))
        for r in group:
            if r["id"] == canonical["id"]:
                continue
            merges[r["id"]] = canonical["id"]

    # Every row (canonical or not) is checked against the place its own
    # articles name.
    for r in rows:
        maj = majority.get(r["id"])
        if not maj:
            continue
        parsed = _parse_place(maj[0], r["country"])
        if not parsed:
            continue
        city, cc = parsed
        target = by_name_coords.get((city, cc))
        if not target:
            continue
        row_name = (r["place_name"] or "").strip()
        row_city = row_name.split(",")[0].strip() if row_name else ""
        if row_city.lower() == city.lower() and (r["country"] or "") == cc:
            continue    # already consistent

        if _close(r["lat"], r["lng"], target[0], target[1]):
            # The coordinates are right — the LABEL is wrong.
            new_name = f"{city}, {cc}"
            key = (new_name.lower(), round(r["lat"], 3), round(r["lng"], 3))
            if key in key_index and key_index[key] != r["id"]:
                continue    # would collide with an existing row — leave it
            label_moves.append((r["id"], new_name, cc))
        else:
            # The articles name a city the row is not sitting on →
            # move the row onto that city.
            coord_moves.append((r["id"], target[0], target[1]))

    return {
        "refs": refs,
        "counts": counts,
        "rows": rows,
        "coord_moves": coord_moves,
        "label_moves": label_moves,
        "merges": merges,
    }


def main():
    parser = argparse.ArgumentParser(description="Repair news_locations duplicates + coordinates")
    parser.add_argument("--dry-run", action="store_true", help="Only report")
    parser.add_argument("--apply", action="store_true", help="Write to DB")
    parser.add_argument("--merge", action="store_true",
                        help="Also merge duplicate rows (repoints every reference — slow)")
    parser.add_argument("--clean-tests", action="store_true", help="Remove 'Test City' rows")
    parser.add_argument("--limit", type=int, default=0, help="Only repair N rows per group")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    apply = args.apply and not args.dry_run

    with connect() as conn, conn.cursor() as cur:
        cur.execute("SET statement_timeout = 0")
        p = plan(cur)
        counts = p["counts"]
        merge_articles = sum(counts.get(old, 0) for old in p["merges"])
        log.info("rows relabelled to the place their own articles name: %d",
                 len(p["label_moves"]))
        log.info("rows moved onto the city their own articles name: %d",
                 len(p["coord_moves"]))
        log.info("duplicate rows to merge: %d (%d articles move)",
                 len(p["merges"]), merge_articles)

        if not apply:
            log.info("\n[dry run] sample relabels:")
            for loc_id, new_name, cc in p["label_moves"][:15]:
                row = next(r for r in p["rows"] if r["id"] == loc_id)
                log.info("  id=%-7s %-26s → %-24s (%d articles)",
                         loc_id, row["place_name"][:26], new_name, counts.get(loc_id, 0))
            log.info("\n[dry run] sample coordinate moves:")
            for loc_id, lat, lng in p["coord_moves"][:15]:
                row = next(r for r in p["rows"] if r["id"] == loc_id)
                log.info("  id=%-7s %-26s (%.4f,%.4f) → (%.4f,%.4f)",
                         loc_id, row["place_name"][:26], row["lat"], row["lng"], lat, lng)
            log.info("\n[dry run] largest merges:")
            for old, new in sorted(p["merges"].items(), key=lambda x: -counts.get(x[0], 0))[:15]:
                row = next(r for r in p["rows"] if r["id"] == old)
                log.info("  id=%-7s %-26s → id=%s (%d articles)",
                         old, row["place_name"][:26], new, counts.get(old, 0))
            log.info("\nRe-run with --apply to persist.")
            conn.rollback()
            return

        refs = p["refs"]

        # 1. relabel rows whose articles name a different place
        labels = p["label_moves"]
        if args.limit:
            labels = labels[:args.limit]
        relabelled = 0
        for loc_id, new_name, cc in labels:
            cur.execute("SAVEPOINT relabel")
            try:
                cur.execute("""
                    UPDATE news_locations
                       SET place_name = %s,
                           place_name_normalized = lower(%s),
                           country = %s
                     WHERE id = %s
                """, (new_name, new_name, cc, loc_id))
                relabelled += 1
                cur.execute("RELEASE SAVEPOINT relabel")
            except Exception as exc:            # unique-key collision etc.
                cur.execute("ROLLBACK TO SAVEPOINT relabel")
                cur.execute("RELEASE SAVEPOINT relabel")
                log.debug("relabel of %s skipped: %s", loc_id, exc)
        log.info("relabelled %d rows to the place their own articles name", relabelled)

        # 2. move rows onto the city their articles name
        moves = p["coord_moves"]
        if args.limit:
            moves = moves[:args.limit]
        moved_rows = 0
        for loc_id, lat, lng in moves:
            cur.execute("SAVEPOINT coordmove")
            try:
                cur.execute("""
                    UPDATE news_locations
                       SET lat = %s, lng = %s,
                           geom = ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
                     WHERE id = %s
                """, (lat, lng, lng, lat, loc_id))
                moved_rows += 1
                cur.execute("RELEASE SAVEPOINT coordmove")
            except Exception as exc:
                cur.execute("ROLLBACK TO SAVEPOINT coordmove")
                cur.execute("RELEASE SAVEPOINT coordmove")
                log.debug("coordinate move of %s skipped: %s", loc_id, exc)
        log.info("moved %d rows onto the city their own articles name", moved_rows)

        # 3. merge duplicate rows — this repoints every reference, so it
        #    is an UPDATE on news_articles and takes a while on a table
        #    this size. Off by default; run it in a quiet window.
        if args.merge:
            mapping = dict(p["merges"])
            if args.limit:
                mapping = dict(list(mapping.items())[:args.limit])
            moved = _repoint(cur, mapping, refs)
            log.info("merged %d rows (%d references moved)", len(mapping), moved)
            for old_id in mapping:
                cur.execute("DELETE FROM news_locations WHERE id = %s", (old_id,))
        elif p["merges"]:
            log.info("%d duplicate rows left in place (run with --merge in a quiet window)",
                     len(p["merges"]))

        # 3. test-suite leftovers
        if args.clean_tests:
            cur.execute("""
                DELETE FROM news_locations l
                WHERE l.place_name = 'Test City'
                  AND NOT EXISTS (SELECT 1 FROM news_articles a WHERE a.location_id = l.id)
                  AND NOT EXISTS (SELECT 1 FROM news_event_locations e WHERE e.location_id = l.id)
            """)
            log.info("removed %d 'Test City' rows", cur.rowcount)

        conn.commit()

        cur.execute("SELECT COUNT(*)::int FROM news_locations")
        log.info("news_locations rows now: %s", cur.fetchone()["count"])


if __name__ == "__main__":
    main()
