"""Audit misplaced pins by detecting city mentions in titles.

Reuses `cities_text.find_cities_in_text()` for non-AI detection. Every
correction is logged to data/audit-log/pins-location-fix-YYYY-MM-DD.jsonl
so the run is fully reversible via `python -m worker.audit_locations
--revert <log>`.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from .cities_text import find_cities_in_text, _INDEX
from .db import connect
from .geo_utils import haversine_m as _haversine_m

log = logging.getLogger("xyzo.audit_locations")

# Public knobs
DISTANCE_THRESHOLD_M = 100_000  # 100 km
LOW_CONFIDENCE_THRESHOLD = 0.5
DEFAULT_LOG_DIR = Path(__file__).parent.parent / "data" / "audit-log"

RULES = ("distance", "country", "low_conf", "title_mismatch")


@dataclass
class Correction:
    """One proposed pin correction. asdict() -> JSONL entry."""
    pin_id: int
    title: str
    before: dict
    after: dict
    detected: dict
    rules_fired: list[str]
    source: dict


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _log_path(log_dir: Path, day: str | None = None) -> Path:
    day = day or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return log_dir / f"pins-location-fix-{day}.jsonl"


def fetch_pins(*, limit: int | None = None, since: str | None = None) -> list[dict]:
    """Return all published pins joined with source country (when derivable).

    For source_type='rss', the source country is looked up via
    rss_details.source_url → news_sources.feed_url. For other
    source_types, source_country is None.
    """
    sql = """
        SELECT p.id, p.title,
               ST_Y(p.location::geometry)  AS lat,
               ST_X(p.location::geometry)  AS lng,
               p.location_precision, p.confidence_score,
               p.status, p.source_type, p.created_at,
               rd.source_feed,
               ns.country AS source_country
          FROM pins p
          LEFT JOIN rss_details rd ON rd.pin_id = p.id
          LEFT JOIN news_sources ns
            ON ns.feed_url = rd.source_url
         WHERE p.status = 'published'
           AND (%(since)s::text IS NULL OR p.created_at >= %(since)s::date)
         ORDER BY p.id ASC
    """
    params: dict = {"since": since}
    if limit is not None:
        sql += " LIMIT %(limit)s"
        params["limit"] = int(limit)
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]


def evaluate_pin(pin: dict, *, rules: tuple[str, ...] | None = None) -> Correction | None:
    """Apply the four miss-rules to one pin. Return a Correction or None."""
    rules = rules or RULES
    title = pin.get("title") or ""
    if not title:
        return None

    matches = find_cities_in_text(title, min_population=100_000)
    if not matches:
        return None
    # Pick the best: name > alias > entity, then by population.
    _kind_rank = {"name": 0, "alias": 1, "entity": 2}
    matches.sort(key=lambda m: (
        _kind_rank.get(m.get("kind"), 9),
        -(m["city"].get("population") or 0),
    ))
    best = matches[0]
    if best.get("confidence") == "low":
        return None

    city = best["city"]
    new_lat = float(city["lat"])
    new_lng = float(city["lng"])
    new_country = city.get("country_code")
    pin_lat = float(pin["lat"])
    pin_lng = float(pin["lng"])

    fired: list[str] = []

    # R1: distance > 100km
    if "distance" in rules:
        d_m = _haversine_m(pin_lat, pin_lng, new_lat, new_lng)
        if d_m > DISTANCE_THRESHOLD_M:
            fired.append("distance")

    # Cache the pin's nearest-world-city country once for R2 and R4
    # (avoids double-iterating all 8k+ rows in _INDEX).
    pin_country: str | None = None
    if ("country" in rules and pin.get("source_country")) or "title_mismatch" in rules:
        pin_country = _nearest_world_city_country(pin_lat, pin_lng)

    # R2: pin's actual country ≠ source country (only when source known).
    # A Bangladesh source reporting a pin placed in Tokyo is a country mismatch.
    if "country" in rules and pin.get("source_country"):
        if pin_country and pin_country != pin["source_country"]:
            fired.append("country")

    # R3: low confidence flag
    if "low_conf" in rules and float(pin.get("confidence_score") or 0) < LOW_CONFIDENCE_THRESHOLD:
        fired.append("low_conf")

    # R4: title mismatch (pin's nearest world_cities country ≠ detected)
    if "title_mismatch" in rules and new_country:
        if pin_country and pin_country != new_country:
            fired.append("title_mismatch")

    if not fired:
        return None

    old_precision = pin.get("location_precision") or "city"
    new_precision = "city"  # title-only detection is at best city-level
    old_conf = float(pin.get("confidence_score") or 0)
    new_conf = min(old_conf, 0.85) if old_conf >= LOW_CONFIDENCE_THRESHOLD else old_conf

    return Correction(
        pin_id=int(pin["id"]),
        title=title,
        before={
            "lat": pin_lat, "lng": pin_lng,
            "precision": old_precision, "confidence": old_conf,
            "country": pin.get("source_country"),
        },
        after={
            "lat": new_lat, "lng": new_lng,
            "precision": new_precision, "confidence": new_conf,
            "country": new_country,
            "place_name": city.get("name"),
        },
        detected={
            "city": city.get("name"),
            "country": new_country,
            "population": city.get("population"),
            "kind": best.get("kind"),
        },
        rules_fired=sorted(set(fired)),
        source={
            "feed": pin.get("source_feed"),
            "country": pin.get("source_country"),
        },
    )


def _nearest_world_city_country(lat: float, lng: float) -> str | None:
    """Return the country_code of the world_cities row closest to (lat, lng)."""
    _INDEX.load()
    best_country = None
    best_d = float("inf")
    for c in _INDEX.cities_by_name.values():
        for r in c:
            d = _haversine_m(lat, lng, float(r["lat"]), float(r["lng"]))
            if d < best_d:
                best_d = d
                best_country = r.get("country_code")
    return best_country


def audit_all_pins(*, limit: int | None = None, since: str | None = None,
                   rules: tuple[str, ...] | None = None) -> list[Correction]:
    """Read-only pass: fetch pins and propose corrections. Does not write."""
    rows = fetch_pins(limit=limit, since=since)
    out: list[Correction] = []
    for row in rows:
        c = evaluate_pin(row, rules=rules)
        if c is not None:
            out.append(c)
    return out


def apply_corrections(corrections: Iterable[Correction], *,
                      log_dir: Path = DEFAULT_LOG_DIR,
                      batch_size: int = 100) -> int:
    """Apply corrections and write a JSONL audit log. Returns count applied.

    Idempotent within the same UTC day: pins already recorded in today's
    JSONL log are skipped on subsequent calls.
    """
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = _log_path(log_dir)

    # Idempotency: read today's log, build a set of already-corrected ids.
    already: set[int] = set()
    if log_path.exists():
        for line in log_path.read_text().splitlines():
            try:
                already.add(json.loads(line)["pin_id"])
            except Exception:
                continue

    pending = [c for c in corrections if c.pin_id not in already]
    if not pending:
        return 0

    with log_path.open("a", encoding="utf-8") as fh:
        with connect() as conn:
            for i in range(0, len(pending), batch_size):
                batch = pending[i:i + batch_size]
                # Write JSONL FIRST so a crash between the UPDATEs and
                # the file flush cannot leave the pin moved without an
                # audit entry (which would break the reversibility
                # promise). The idempotency check above already
                # guarantees the same pin isn't logged twice today.
                for c in batch:
                    fh.write(json.dumps({
                        "ts": _now_iso(),
                        "pin_id": c.pin_id,
                        "title": c.title,
                        "before": c.before,
                        "after": c.after,
                        "detected": c.detected,
                        "rules_fired": c.rules_fired,
                        "source": c.source,
                    }, ensure_ascii=False) + "\n")
                fh.flush()
                with conn.cursor() as cur:
                    for c in batch:
                        cur.execute(
                            """
                            UPDATE pins
                               SET location = ST_SetSRID(
                                      ST_MakePoint(%s, %s), 4326)::geography,
                                   location_precision = %s,
                                   confidence_score = %s,
                                   updated_at = now()
                             WHERE id = %s
                            """,
                            (c.after["lng"], c.after["lat"],
                             c.after["precision"], c.after["confidence"],
                             c.pin_id),
                        )
                conn.commit()
    return len(pending)
def revert_from_log(log_path: Path) -> tuple[int, int]:
    """Inverse-apply every correction recorded in `log_path`.

    Returns (reverted_count, missing_count).
    """
    log_path = Path(log_path)
    if not log_path.exists():
        raise FileNotFoundError(log_path)

    reverted = 0
    missing = 0
    with connect() as conn, conn.cursor() as cur:
        for line in log_path.read_text().splitlines():
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            before = entry["before"]
            cur.execute(
                """
                UPDATE pins
                   SET location = ST_SetSRID(
                          ST_MakePoint(%s, %s), 4326)::geography,
                       location_precision = %s,
                       confidence_score = %s,
                       updated_at = now()
                 WHERE id = %s
                """,
                (before["lng"], before["lat"],
                 before["precision"], before["confidence"],
                 entry["pin_id"]),
            )
            if cur.rowcount == 0:
                missing += 1
            else:
                reverted += 1
        conn.commit()
    return reverted, missing


def cli(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="python -m worker.audit_locations",
        description="Audit pins.lat/lng against non-AI city detection on titles.",
    )
    p.add_argument("--apply", action="store_true",
                   help="Apply corrections (default: dry-run)")
    p.add_argument("--dry-run", action="store_true",
                   help="Force dry-run (default if --apply absent)")
    p.add_argument("--limit", type=int, default=None,
                   help="Only audit the first N pins")
    p.add_argument("--since", type=str, default=None,
                   help="Only pins created on/after YYYY-MM-DD")
    p.add_argument("--rules", type=str, default=None,
                   help=f"Comma-separated subset of: {','.join(RULES)}")
    p.add_argument("--revert", type=str, default=None,
                   help="Revert from a JSONL log file")
    p.add_argument("--batch-size", type=int, default=100,
                   help="Commit every N corrections (default 100)")
    p.add_argument("--log-dir", type=str, default=str(DEFAULT_LOG_DIR),
                   help="Override audit log dir")
    p.add_argument("-v", "--verbose", action="store_true",
                   help="Print per-pin decisions")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    # Revert path
    if args.revert:
        log_path = Path(args.revert)
        reverted, missing = revert_from_log(log_path)
        print(f"Reverted {reverted} pins. {missing} pins not found (already changed).")
        return 0

    rules: tuple[str, ...] | None = None
    if args.rules:
        rules = tuple(r.strip() for r in args.rules.split(",") if r.strip())
        for r in rules:
            if r not in RULES:
                print(f"Unknown rule: {r}. Valid: {','.join(RULES)}", file=sys.stderr)
                return 2

    if args.apply and args.dry_run:
        print("--apply and --dry-run are mutually exclusive.", file=sys.stderr)
        return 2

    corrections = audit_all_pins(limit=args.limit, since=args.since, rules=rules)
    print(f"Audited. {len(corrections)} corrections proposed.")
    if args.verbose:
        for c in corrections:
            print(f"  pin {c.pin_id}: {c.title[:60]} → "
                  f"({c.after['lat']:.4f}, {c.after['lng']:.4f}) "
                  f"[{','.join(c.rules_fired)}]")

    if args.apply:
        n = apply_corrections(
            corrections,
            log_dir=Path(args.log_dir),
            batch_size=args.batch_size,
        )
        print(f"Applied {n} corrections.")
    else:
        print("Dry-run. Pass --apply to write changes.")

    return 0


if __name__ == "__main__":
    sys.exit(cli())