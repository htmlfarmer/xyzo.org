"""Newsium Cities CLI — curate and perfect the cities reference.

Connects to xyzo_cities as cities_writer. Reads from cities_reader
where only SELECT is needed.

Usage:
    python -m worker.cities_cli stats
    python -m worker.cities_cli search "mumbai" --country IN
    python -m worker.cities_cli show <id>
    python -m worker.cities_cli add "City,Country,lat,lng,pop"
    python -m worker.cities_cli alias <city_id> <alias> [--lang en]
    python -m worker.cities_cli merge <from_id> <into_id>
    python -m worker.cities_cli validate <id> [--score 80] [--note "..."]
    python -m worker.cities_cli review-anomalies [--limit 50]
    python -m worker.cities_cli history <city_id>
    python -m worker.cities_cli export  # regenerate JS bundle
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import sys
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from .load_cities import ascii_fold, title_case, validate_row

log = logging.getLogger("xyzo.cities_cli")

CITIES_READER_DSN = os.environ.get(
    "XYZO_CITIES_READER_DSN",
    "postgresql://cities_reader:CHANGE_ME@localhost:5432/xyzo_cities",
)
CITIES_WRITER_DSN = os.environ.get(
    "XYZO_CITIES_WRITER_DSN",
    "postgresql://cities_writer:CHANGE_ME@localhost:5432/xyzo_cities",
)
OUTPUT_DIR = Path(__file__).parent.parent / "data"


def _writer():
    return psycopg.connect(CITIES_WRITER_DSN)


def _reader():
    return psycopg.connect(CITIES_READER_DSN, row_factory=dict_row)


# ── Commands ─────────────────────────────────────────────────────────
def cmd_stats(_args):
    with _reader() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT total_cities, total_countries, total_aliases,
                   last_load_at, last_load_source, last_load_row_count
            FROM cities_admin.manifest
        """)
        m = cur.fetchone()
        cur.execute("SELECT source::text AS source, COUNT(*)::int AS n FROM public.cities GROUP BY 1 ORDER BY 2 DESC")
        by_source = cur.fetchall()
        cur.execute("""
            SELECT source::text AS source, COUNT(*)::int AS n
            FROM public.city_aliases GROUP BY 1 ORDER BY 2 DESC
        """)
        alias_sources = cur.fetchall()
        cur.execute("""
            SELECT validation_score, COUNT(*)::int AS n
            FROM public.cities GROUP BY 1 ORDER BY 1
        """)
        score_dist = cur.fetchall()
        cur.execute("""
            SELECT COUNT(*)::int AS flagged
            FROM public.cities
            WHERE notes LIKE '%%bbox_out%%' OR notes LIKE '%%db_position_disagree%%'
                OR notes LIKE '%%country_unrecognized%%'
        """)
        flagged = cur.fetchone()["flagged"]

    print("\n=== Newsium Cities Reference ===\n")
    print(f"Total cities:    {m['total_cities']:,}")
    print(f"Total countries: {m['total_countries']:,}")
    print(f"Total aliases:   {m['total_aliases']:,}")
    print(f"Last load:       {m['last_load_at']} (source={m['last_load_source']}, rows={m['last_load_row_count']})")
    print(f"\nCities by source:")
    for r in by_source:
        print(f"  {r['source']:12s} {r['n']:>6,}")
    print(f"\nAliases by source:")
    for r in alias_sources:
        print(f"  {r['source']:12s} {r['n']:>6,}")
    print(f"\nValidation score distribution:")
    for r in score_dist:
        print(f"  score={r['validation_score']:>3}: {r['n']:>6,}")
    print(f"\nFlagged for review: {flagged}")


def cmd_search(args):
    with _reader() as conn, conn.cursor() as cur:
        country_arg = args.country.upper() if args.country else None
        cur.execute("""
            SELECT s.id, s.name, s.ascii_name, s.country_code, s.state_name,
                   s.latitude, s.longitude, s.population, c.source, c.validation_score,
                   s.match_kind
            FROM public.search_cities(%s::TEXT, %s::CHAR(2), 0::INT, %s::INT) s
            JOIN public.cities c ON c.id = s.id
        """, (args.query, country_arg, args.limit))
        rows = cur.fetchall()
    print(f"\nSearch: {args.query!r} → {len(rows)} results\n")
    for r in rows:
        print(f"  {r['id']:>6} {r['name']:35s} {r['country_code']} pop={r['population']:>10,} match={r['match_kind']} score={r['validation_score']}")


def cmd_show(args):
    with _reader() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT * FROM public.cities WHERE id = %s OR geoname_id = %s LIMIT 1
        """, (args.id, args.id))
        row = cur.fetchone()
        if not row:
            print(f"  city {args.id} not found", file=sys.stderr)
            return 1
        cur.execute("""
            SELECT alias, language, source, created_at
            FROM public.city_aliases WHERE city_id = %s ORDER BY alias
        """, (row["id"],))
        aliases = cur.fetchall()
        cur.execute("""
            SELECT action, field, old_value, new_value, changed_by, changed_at, note
            FROM cities_admin.history WHERE city_id = %s ORDER BY changed_at DESC LIMIT 20
        """, (row["id"],))
        history = cur.fetchall()

    print(f"\n=== City {row['id']} ===\n")
    for k in ("name", "ascii_name", "country_code", "state_code", "state_name",
              "latitude", "longitude", "population", "elevation_m", "timezone",
              "feature_code", "geoname_id", "source", "validation_score",
              "validated_at", "validated_by", "notes", "created_at", "updated_at"):
        print(f"  {k:20s} {row[k]}")
    if aliases:
        print(f"\n  Aliases ({len(aliases)}):")
        for a in aliases:
            print(f"    {a['alias']} [{a['language']}] src={a['source']}")
    if history:
        print(f"\n  Recent history:")
        for h in history:
            what = f"{h['field']}: {h['old_value']} -> {h['new_value']}" if h['field'] else (h['note'] or h['action'])
            print(f"    {h['changed_at']} {h['action']:8s} {what} (by {h['changed_by']})")


def cmd_add(args):
    """Add a city. Accepts either CSV row string or --lat/--lng/--pop."""
    if args.csv_row:
        parts = [p.strip() for p in args.csv_row.split(",")]
        if len(parts) != 5:
            print("CSV row must be: name,country,lat,lng,population", file=sys.stderr)
            return 1
        name, country, lat, lng, pop = parts
    else:
        name = args.name
        country = args.country
        lat = args.lat
        lng = args.lng
        pop = args.pop

    cleaned, anomalies = validate_row({
        "city": name, "country": country, "state": "",
        "lat": lat, "lng": lng, "population": pop,
    })
    if cleaned is None:
        print(f"  rejected: {anomalies}", file=sys.stderr)
        return 1
    if anomalies:
        print(f"  anomalies: {anomalies}")

    search_text = " | ".join(filter(None, [
        cleaned["ascii_name"], cleaned["name"], country,
    ])).lower()

    with _writer() as conn, conn.cursor() as cur:
        cur.execute("""
            INSERT INTO public.cities (
                name, ascii_name, country_code, state_name,
                latitude, longitude, population, source,
                validated_at, validated_by, notes, search_text,
                validation_score
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,'manual'::cities_admin.source_kind,
                      now(),%s,%s,%s, %s)
            RETURNING id
        """, (
            cleaned["name"], cleaned["ascii_name"], cleaned["country_code"],
            cleaned["state_name"], cleaned["lat"], cleaned["lng"], cleaned["population"],
            os.environ.get("USER", "manual"),
            "; ".join(anomalies) if anomalies else None,
            search_text, args.score,
        ))
        new_id = cur.fetchone()[0]
        conn.commit()
    print(f"  added city id={new_id} ({cleaned['name']}, {cleaned['country_code']})")
    return 0


def cmd_alias(args):
    with _writer() as conn, conn.cursor() as cur:
        cur.execute("""
            INSERT INTO public.city_aliases (city_id, alias, language, source)
            VALUES (%s, %s, %s, 'manual'::cities_admin.source_kind)
            ON CONFLICT (lower(alias), language) DO UPDATE
                SET city_id = EXCLUDED.city_id
            RETURNING id
        """, (args.city_id, args.alias, args.lang))
        conn.commit()
    print(f"  alias {args.alias!r} → city {args.city_id}")


def cmd_merge(args):
    """Merge from_id into into_id: copy aliases + delete from row."""
    with _writer() as conn, conn.cursor() as cur:
        cur.execute("SELECT id, name, country_code FROM public.cities WHERE id IN (%s, %s) ORDER BY id",
                    (args.from_id, args.into_id))
        rows = cur.fetchall()
        if len(rows) != 2:
            print("  both ids must exist", file=sys.stderr); return 1
        if rows[0]["country_code"] != rows[1]["country_code"]:
            print(f"  refuse: countries differ ({rows[0]['country_code']} vs {rows[1]['country_code']})", file=sys.stderr)
            return 1
        # Move aliases
        cur.execute("""
            UPDATE public.city_aliases SET city_id = %s
            WHERE city_id = %s
              AND lower(alias) NOT IN (SELECT lower(alias) FROM public.city_aliases WHERE city_id = %s)
        """, (args.into_id, args.from_id, args.into_id))
        moved = cur.rowcount
        # Update history
        cur.execute("""
            INSERT INTO cities_admin.history (city_id, action, source, changed_by, note)
            VALUES (%s, 'merge', 'manual', %s, %s)
        """, (args.into_id, os.environ.get("USER", "manual"),
              f"merged city {args.from_id} into {args.into_id} (moved {moved} aliases)"))
        # Delete the from row (trigger records 'delete' in history)
        cur.execute("DELETE FROM public.cities WHERE id = %s", (args.from_id,))
        conn.commit()
    print(f"  merged {args.from_id} into {args.into_id}: {moved} aliases moved")
    return 0


def cmd_validate(args):
    with _writer() as conn, conn.cursor() as cur:
        cur.execute("""
            UPDATE public.cities
               SET validation_score = %s,
                   validated_at = now(),
                   validated_by = %s,
                   notes = COALESCE(%s, notes)
             WHERE id = %s OR geoname_id = %s
            RETURNING id
        """, (args.score, os.environ.get("USER", "manual"), args.note,
              args.id, args.id))
        updated = cur.fetchall()
        conn.commit()
    if not updated:
        print("  no rows updated", file=sys.stderr); return 1
    print(f"  validated {len(updated)} row(s) at score {args.score}: {[r[0] for r in updated]}")
    return 0


def cmd_review_anomalies(args):
    with _reader() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, name, country_code, latitude, longitude,
                   population, source, validation_score, notes
            FROM public.cities
            WHERE notes LIKE '%%bbox_out%%'
               OR notes LIKE '%%db_position_disagree%%'
               OR notes LIKE '%%country_unrecognized%%'
            ORDER BY id DESC
            LIMIT %s
        """, (args.limit,))
        rows = cur.fetchall()
    print(f"\n=== Flagged for review ({len(rows)}) ===\n")
    for r in rows:
        print(f"  {r['id']:>6} {r['name']:35s} {r['country_code']} lat={r['latitude']} lng={r['longitude']} pop={r['population']}")
        print(f"          score={r['validation_score']} src={r['source']}")
        print(f"          notes: {r['notes']}")


def cmd_history(args):
    with _reader() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT changed_at, action, field, old_value, new_value, changed_by, note
            FROM cities_admin.history
            WHERE city_id = %s
            ORDER BY changed_at DESC
            LIMIT %s
        """, (args.city_id, args.limit))
        rows = cur.fetchall()
    for r in rows:
        print(f"  {r['changed_at']} {r['action']:10s} by={r['changed_by']}")
        if r["field"]:
            print(f"    {r['field']}: {r['old_value']} → {r['new_value']}")
        if r["note"]:
            print(f"    note: {r['note']}")


def cmd_export(_args):
    """Regenerate the JS bundle from xyzo_cities."""
    OUTPUT_DIR.mkdir(exist_ok=True)
    with _reader() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT c.id, c.geoname_id, co.alpha3, co.name AS country_name,
                   c.name, c.ascii_name, c.country_code, c.state_name,
                   c.latitude, c.longitude, c.population,
                   c.timezone, c.feature_code, c.source, c.validation_score
            FROM public.cities c
            LEFT JOIN public.countries co ON co.code = c.country_code
            WHERE c.population >= 100000
            ORDER BY c.population DESC
        """)
        rows = [dict(r) for r in cur.fetchall()]
    full_path = OUTPUT_DIR / "cities.json"
    with full_path.open("w", encoding="utf-8") as f:
        json.dump({
            "version": "3.0",
            "source_db": "xyzo_cities",
            "generated": __import__("time").strftime("%Y-%m-%dT%H:%M:%SZ", __import__("time").gmtime()),
            "count": len(rows),
            "cities": rows,
        }, f, ensure_ascii=False, indent=2)
    min_path = OUTPUT_DIR / "cities.min.json"
    min_cities = [
        {
            "n": r["name"], "a": r["ascii_name"], "cc": r["country_code"],
            "s": r["state_name"] or "", "la": round(float(r["latitude"]), 4),
            "ln": round(float(r["longitude"]), 4), "p": int(r["population"]),
        } for r in rows
    ]
    with min_path.open("w", encoding="utf-8") as f:
        json.dump(min_cities, f, ensure_ascii=False, separators=(",", ":"))
    # Copy to public_html too
    public_min = Path(__file__).parent.parent / "public_html" / "data" / "cities.min.json"
    public_min.parent.mkdir(exist_ok=True)
    public_min.write_bytes(min_path.read_bytes())
    print(f"  exported {len(rows):,} cities to {min_path} ({min_path.stat().st_size//1024} KB)")
    print(f"  copied to {public_min}")
    return 0


# ── main ─────────────────────────────────────────────────────────────
def main() -> int:
    p = argparse.ArgumentParser(description="Newsium Cities CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("stats")
    s = sub.add_parser("search"); s.add_argument("query"); s.add_argument("--country"); s.add_argument("--limit", type=int, default=10)
    s = sub.add_parser("show"); s.add_argument("id", type=int)
    a = sub.add_parser("add")
    a.add_argument("csv_row", nargs="?", help='"Name,Country,lat,lng,pop"')
    a.add_argument("--name"); a.add_argument("--country"); a.add_argument("--lat", type=float)
    a.add_argument("--lng", type=float); a.add_argument("--pop", type=int)
    a.add_argument("--score", type=int, default=70, help="initial validation score (0-100)")
    a = sub.add_parser("alias")
    a.add_argument("city_id", type=int); a.add_argument("alias"); a.add_argument("--lang", default="en")
    a = sub.add_parser("merge"); a.add_argument("from_id", type=int); a.add_argument("into_id", type=int)
    a = sub.add_parser("validate")
    a.add_argument("id", type=int); a.add_argument("--score", type=int, default=80)
    a.add_argument("--note", help="human-readable note")
    a = sub.add_parser("review-anomalies"); a.add_argument("--limit", type=int, default=50)
    a = sub.add_parser("history"); a.add_argument("city_id", type=int); a.add_argument("--limit", type=int, default=20)
    sub.add_parser("export")

    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    fn = globals().get(f"cmd_{args.cmd.replace('-', '_')}")
    if fn is None:
        p.print_help(); return 1
    return fn(args) or 0


if __name__ == "__main__":
    sys.exit(main())
