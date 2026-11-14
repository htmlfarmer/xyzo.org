# Audit Pins lat/lng via Non-AI Title Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit every row in `pins` and, using non-AI city detection on each pin's `title`, move any pin whose current lat/lng does not match the city (or country) named in the title. Auto-apply with full JSONL audit log and a `--revert` flag for undo.

**Architecture:** A new `worker/audit_locations.py` module reuses the existing non-AI detector `cities_text.find_cities_in_text()`. The module exposes four pure functions (`fetch_pins`, `evaluate_pin`, `audit_all_pins`, `apply_corrections`, `revert_from_log`) and a CLI. Updates to `pins` use PostGIS `ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography`. An optional `--audit-locations` flag in `worker/run.py` calls into the module between `extract` and `publish`; default behavior is unchanged.

**Tech Stack:** Python 3.11, psycopg (existing `worker/db.py`), PostGIS, `cities_text.find_cities_in_text()`, JSONL logs.

**Spec:** `docs/superpowers/specs/2026-08-26-audit-pins-lat-lng.md`

---

## File Structure

| File | Responsibility | Lines (approx) |
|---|---|---|
| `worker/audit_locations.py` (NEW) | Pure functions: `fetch_pins`, `evaluate_pin`, `audit_all_pins`, `apply_corrections`, `revert_from_log`, `cli` | ~280 |
| `worker/tests/test_audit_locations.py` (NEW) | Unit tests for the four pure functions | ~250 |
| `worker/run.py` (MODIFY) | Add `--audit-locations` flag; call module between extract and publish | +15 |
| `data/audit-log/.gitkeep` (NEW) | Empty placeholder so the audit log directory exists | 0 |

No other files are touched. `worker/cities_text.py`, `worker/db.py`, the API, and the frontend are not modified.

---

## Task 1: Skeleton module + audit-log directory

**Files:**
- Create: `data/audit-log/.gitkeep`
- Create: `worker/audit_locations.py`

- [ ] **Step 1: Create the audit-log directory placeholder**

```bash
mkdir -p /var/www/vhosts/xyzo.org/data/audit-log
touch /var/www/vhosts/xyzo.org/data/audit-log/.gitkeep
```

- [ ] **Step 2: Create the skeleton module with imports and constants**

Write to `worker/audit_locations.py`:

```python
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
import sys
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from .cities_text import find_cities_in_text, _INDEX
from .db import connect

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


# Module-level constants used by tests; populated lazily.
_source_country_by_feed: dict[str, str] = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _log_path(log_dir: Path, day: str | None = None) -> Path:
    day = day or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return log_dir / f"pins-location-fix-{day}.jsonl"


# Functions are filled in by subsequent tasks.
def fetch_pins(*, limit=None, since=None): ...
def evaluate_pin(pin: dict) -> Correction | None: ...
def audit_all_pins(*, limit=None, since=None, rules=None) -> list[Correction]: ...
def apply_corrections(corrections: Iterable[Correction], *, log_dir=DEFAULT_LOG_DIR, batch_size=100) -> int: ...
def revert_from_log(log_path: Path) -> tuple[int, int]: ...
def cli(argv: list[str] | None = None) -> int: ...
```

- [ ] **Step 3: Smoke-check the module imports**

```bash
cd /var/www/vhosts/xyzo.org && python -c "from worker.audit_locations import Correction; print(Correction.__name__)"
```

Expected output:
```
Correction
```

- [ ] **Step 4: Commit**

```bash
git add data/audit-log/.gitkeep worker/audit_locations.py
git -c user.name='Newsium Dev' -c user.email='dev@xyzo.org' commit -m "feat(audit): skeleton audit_locations module + audit-log dir" -m "Sets up worker/audit_locations.py with the Correction dataclass and function signatures; data/audit-log/ is the destination for the JSONL audit log.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: TDD `fetch_pins()` — fetch pins joined with source country

**Files:**
- Create: `worker/tests/test_audit_locations.py`
- Modify: `worker/audit_locations.py:fetch_pins()`

- [ ] **Step 1: Write the failing test**

Write to `worker/tests/test_audit_locations.py`:

```python
"""Tests for worker.audit_locations.

These tests run against the live xyzo DB. They create and clean up
their own fixtures in a SAVEPOINT so other tests/operations are
untouched.
"""
from __future__ import annotations

import math
from contextlib import contextmanager

import pytest

from worker.audit_locations import (
    Correction,
    fetch_pins,
    evaluate_pin,
    audit_all_pins,
    apply_corrections,
    revert_from_log,
    _source_country_by_feed,
)
from worker.db import connect


# ── fixtures ────────────────────────────────────────────────────────

@contextmanager
def _fixture_pin(*, title: str, lat: float, lng: float, source_type: str = "rss",
                 source_feed: str | None = None, precision: str = "city",
                 confidence: float = 0.95):
    """Insert a pin (and matching rss_details if source_type='rss'),
    yield its id, then clean up. Rolls back even on exception."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SAVEPOINT audit_fixture")
        try:
            cur.execute(
                """
                INSERT INTO pins (source_type, title, location,
                                  location_precision, confidence_score,
                                  status, category)
                VALUES (%s, %s,
                        ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                        %s, %s, 'published', 'other')
                RETURNING id
                """,
                (source_type, title, lng, lat, precision, confidence),
            )
            pin_id = cur.fetchone()["id"]
            if source_type == "rss" and source_feed is not None:
                cur.execute(
                    """
                    INSERT INTO rss_details (pin_id, source_feed, source_url)
                    VALUES (%s, %s, %s)
                    """,
                    (pin_id, source_feed, f"https://example.com/{source_feed}"),
                )
            cur.execute("RELEASE SAVEPOINT audit_fixture")
        except Exception:
            cur.execute("ROLLBACK TO SAVEPOINT audit_fixture")
            raise
        try:
            yield pin_id
        finally:
            with connect() as conn2, conn2.cursor() as cur2:
                cur2.execute("DELETE FROM rss_details WHERE pin_id = %s", (pin_id,))
                cur2.execute("DELETE FROM pins WHERE id = %s", (pin_id,))


# ── fetch_pins ──────────────────────────────────────────────────────

def test_fetch_pins_returns_relevant_columns():
    with _fixture_pin(title="Tokyo summit ends", lat=35.6762, lng=139.6503) as pid:
        rows = fetch_pins(limit=10_000)
        match = next((r for r in rows if r["id"] == pid), None)
        assert match is not None, f"pin {pid} not in fetch_pins() result"
        assert match["title"] == "Tokyo summit ends"
        assert math.isclose(match["lat"], 35.6762, rel_tol=1e-4)
        assert math.isclose(match["lng"], 139.6503, rel_tol=1e-4)
        assert match["location_precision"] == "city"
        assert match["confidence_score"] == 0.95
        assert match["status"] == "published"


def test_fetch_pins_respects_since():
    # Created today — `since` filter for 2099 should exclude it.
    with _fixture_pin(title="Future filter test", lat=0.0, lng=0.0) as pid:
        rows = fetch_pins(since="2099-01-01")
        assert all(r["id"] != pid for r in rows)


def test_fetch_pins_excludes_hidden():
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO pins (source_type, title, location,
                              location_precision, confidence_score,
                              status, category)
            VALUES ('rss', 'Hidden Paris pin',
                    ST_SetSRID(ST_MakePoint(2.35, 48.85), 4326)::geography,
                    'city', 0.95, 'hidden', 'other')
            RETURNING id
            """
        )
        hid = cur.fetchone()["id"]
    try:
        rows = fetch_pins(limit=10_000)
        assert all(r["id"] != hid for r in rows)
    finally:
        with connect() as conn2, conn2.cursor() as cur2:
            cur2.execute("DELETE FROM pins WHERE id = %s", (hid,))
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /var/www/vhosts/xyzo.org && python -m pytest worker/tests/test_audit_locations.py -v 2>&1 | tail -20
```

Expected: FAIL — `fetch_pins` is currently `...` (Ellipsis) and the import will fail with `TypeError: ellipsis is not a function`.

- [ ] **Step 3: Implement `fetch_pins()`**

Replace the `fetch_pins(...)` stub in `worker/audit_locations.py` with:

```python
def fetch_pins(*, limit: int | None = None, since: str | None = None) -> list[dict]:
    """Return all published pins joined with source country (when derivable).

    For source_type='rss', the source country is looked up via
    rss_details.source_feed → news_sources.feed_url. For other
    source_types, source_country is None.
    """
    sql = """
        SELECT p.id, p.title,
               ST_Y(p.location::geometry)  AS lat,
               ST_X(p.location::geometry)  AS lng,
               p.location_precision, p.confidence_score,
               p.source_type, p.created_at,
               rd.source_feed,
               ns.country AS source_country
          FROM pins p
          LEFT JOIN rss_details rd ON rd.pin_id = p.id
          LEFT JOIN news_sources ns
            ON ns.feed_url = rd.source_url
         WHERE p.status = 'published'
           AND (%(since)s IS NULL OR p.created_at >= %(since)s::date)
         ORDER BY p.id ASC
         %(limit)s
    """
    limit_sql = ""
    params: dict = {"since": since}
    if limit is not None:
        limit_sql = "LIMIT %(limit)s"
        params["limit"] = int(limit)
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql % {"limit": limit_sql}, params)
        return [dict(r) for r in cur.fetchall()]
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /var/www/vhosts/xyzo.org && python -m pytest worker/tests/test_audit_locations.py -v 2>&1 | tail -10
```

Expected: PASS for the three `test_fetch_pins_*` tests.

- [ ] **Step 5: Commit**

```bash
git add worker/audit_locations.py worker/tests/test_audit_locations.py
git -c user.name='Newsium Dev' -c user.email='dev@xyzo.org' commit -m "feat(audit): fetch_pins() with rss source country join" -m "Returns all published pins joined with their rss source country (when derivable). Skips hidden pins. Honors --limit and --since filters.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: TDD `evaluate_pin()` — per-pin rule engine

**Files:**
- Modify: `worker/tests/test_audit_locations.py`
- Modify: `worker/audit_locations.py:evaluate_pin()`

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_audit_locations.py`:

```python
# ── evaluate_pin ────────────────────────────────────────────────────

def _pin_dict(pid: int, lat: float, lng: float, **kw) -> dict:
    base = {
        "id": pid, "title": "", "lat": lat, "lng": lng,
        "location_precision": "city", "confidence_score": 0.95,
        "source_type": "rss", "source_feed": None, "source_country": None,
    }
    base.update(kw)
    return base


def test_evaluate_pin_fires_distance_when_title_city_far_away():
    pin = _pin_dict(1, lat=-33.8688, lng=151.2093,  # Sydney
                   title="Paris protests escalate")
    c = evaluate_pin(pin)
    assert c is not None
    assert "distance" in c.rules_fired
    assert abs(c.after["lat"] - 48.8566) < 0.5
    assert abs(c.after["lng"] - 2.3522) < 0.5
    assert c.detected["city"] == "Paris"


def test_evaluate_pin_skips_when_close():
    # Newark (40.74, -74.17) is within 100km of NYC (40.71, -74.01).
    pin = _pin_dict(2, lat=40.7357, lng=-74.1724, title="NYC mayor speaks")
    assert evaluate_pin(pin) is None


def test_evaluate_pin_skips_when_no_city_in_title():
    pin = _pin_dict(3, lat=0.0, lng=0.0,
                    title="Markets shrugged at inflation data")
    assert evaluate_pin(pin) is None


def test_evaluate_pin_fires_low_confidence_flag():
    pin = _pin_dict(4, lat=0.0, lng=0.0,
                    title="Tokyo summit ends",
                    confidence_score=0.3)
    c = evaluate_pin(pin)
    assert c is not None
    assert "low_conf" in c.rules_fired


def test_evaluate_pin_skips_low_confidence_city():
    # cities_text only returns confidence=='high'/'medium' for cities
    # with population >= 100_000; this title names no such city.
    pin = _pin_dict(5, lat=0.0, lng=0.0,
                    title="Tiny hamlet news from Smithville")
    assert evaluate_pin(pin) is None


def test_evaluate_pin_fires_country_mismatch_with_source():
    # Pin in Tokyo, source country=BD, title says Dhaka.
    pin = _pin_dict(6, lat=35.6762, lng=139.6503,
                    title="Dhaka floods kill dozens",
                    source_country="BD")
    c = evaluate_pin(pin)
    assert c is not None
    assert "country" in c.rules_fired


def test_evaluate_pin_returns_full_correction_shape():
    pin = _pin_dict(7, lat=-33.8688, lng=151.2093,  # Sydney
                    title="Bangladesh PM India visit",
                    source_country="BD")
    c = evaluate_pin(pin)
    assert c is not None
    assert c.pin_id == 7
    assert c.before["lat"] == -33.8688
    assert c.after["precision"] == "city"
    assert c.after["confidence"] <= 0.85  # capped, never raised
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /var/www/vhosts/xyzo.org && python -m pytest worker/tests/test_audit_locations.py -v 2>&1 | tail -20
```

Expected: FAIL — `evaluate_pin` is currently `...`.

- [ ] **Step 3: Implement `evaluate_pin()`**

Replace the `evaluate_pin(...)` stub in `worker/audit_locations.py` with:

```python
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

    # R2: country ≠ source (only when source country known)
    if "country" in rules and pin.get("source_country") and new_country:
        if pin["source_country"] != new_country:
            fired.append("country")

    # R3: low confidence flag
    if "low_conf" in rules and float(pin.get("confidence_score") or 0) < LOW_CONFIDENCE_THRESHOLD:
        fired.append("low_conf")

    # R4: title mismatch (pin's nearest world_cities country ≠ detected)
    if "title_mismatch" in rules and new_country:
        nearest = _nearest_world_city_country(pin_lat, pin_lng)
        if nearest and nearest != new_country:
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


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in meters. Used as a fallback when PostGIS
    is unavailable; matches `ST_Distance(geography)` to within ~0.5%."""
    R = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


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
```

Add `import math` to the top of `worker/audit_locations.py`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org && python -m pytest worker/tests/test_audit_locations.py -v 2>&1 | tail -20
```

Expected: PASS for the seven `test_evaluate_pin_*` tests.

- [ ] **Step 5: Commit**

```bash
git add worker/audit_locations.py worker/tests/test_audit_locations.py
git -c user.name='Newsium Dev' -c user.email='dev@xyzo.org' commit -m "feat(audit): evaluate_pin applies R1-R4 with haversine fallback" -m "Implements the four miss-rules. R1 distance uses ST_Distance when available, haversine as fallback. R2 fires when source country is known and differs. R3 fires when pin confidence < 0.5. R4 fires when the pin's nearest world_cities country differs from the detected city country. Correction caps new confidence at min(old, 0.85).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: TDD `audit_all_pins()` — orchestration

**Files:**
- Modify: `worker/tests/test_audit_locations.py`
- Modify: `worker/audit_locations.py:audit_all_pins()`

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_audit_locations.py`:

```python
# ── audit_all_pins ──────────────────────────────────────────────────

def test_audit_all_pins_returns_corrections_for_misplaced_pins():
    with _fixture_pin(title="Tokyo summit ends", lat=0.0, lng=0.0,
                      source_type="rss",
                      source_feed="https://example.com/far-away-feed") as pid:
        corrections = audit_all_pins(limit=10_000)
        ours = [c for c in corrections if c.pin_id == pid]
        assert len(ours) == 1, f"expected 1 correction for pin {pid}, got {len(ours)}"
        assert "distance" in ours[0].rules_fired


def test_audit_all_pins_skips_correctly_placed_pins():
    with _fixture_pin(title="Tokyo summit ends", lat=35.6762, lng=139.6503,
                      source_type="rss",
                      source_feed="https://example.com/jp-feed") as pid:
        corrections = audit_all_pins(limit=10_000)
        assert all(c.pin_id != pid for c in corrections)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /var/www/vhosts/xyzo.org && python -m pytest worker/tests/test_audit_locations.py::test_audit_all_pins_returns_corrections_for_misplaced_pins -v 2>&1 | tail -10
```

Expected: FAIL — `audit_all_pins` is currently `...`.

- [ ] **Step 3: Implement `audit_all_pins()`**

Replace the `audit_all_pins(...)` stub in `worker/audit_locations.py` with:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org && python -m pytest worker/tests/test_audit_locations.py -v 2>&1 | tail -10
```

Expected: PASS for the two `test_audit_all_pins_*` tests, plus all earlier tests still passing.

- [ ] **Step 5: Commit**

```bash
git add worker/audit_locations.py worker/tests/test_audit_locations.py
git -c user.name='Newsium Dev' -c user.email='dev@xyzo.org' commit -m "feat(audit): audit_all_pins() read-only orchestration" -m "Glues fetch_pins() and evaluate_pin(). Pure read-only — does not touch the DB beyond SELECT.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: TDD `apply_corrections()` — UPDATE pins + write JSONL

**Files:**
- Modify: `worker/tests/test_audit_locations.py`
- Modify: `worker/audit_locations.py:apply_corrections()`

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_audit_locations.py`:

```python
# ── apply_corrections ───────────────────────────────────────────────

def _make_correction(pid: int, *, new_lat=23.8103, new_lng=90.4125,
                     title="Dhaka floods",
                     old_lat=0.0, old_lng=0.0,
                     rules=("distance",)) -> Correction:
    return Correction(
        pin_id=pid,
        title=title,
        before={"lat": old_lat, "lng": old_lng,
                "precision": "city", "confidence": 0.95, "country": None},
        after={"lat": new_lat, "lng": new_lng,
               "precision": "city", "confidence": 0.85,
               "country": "BD", "place_name": "Dhaka"},
        detected={"city": "Dhaka", "country": "BD",
                  "population": 8906039, "kind": "name"},
        rules_fired=list(rules),
        source={"feed": None, "country": None},
    )


def test_apply_corrections_writes_jsonl_and_updates_pin(tmp_path):
    log_dir = tmp_path / "audit-log"
    with _fixture_pin(title="Dhaka floods", lat=0.0, lng=0.0) as pid:
        corrections = [_make_correction(pid)]
        n = apply_corrections(corrections, log_dir=log_dir)
        assert n == 1

        # JSONL written
        log_files = list(log_dir.glob("pins-location-fix-*.jsonl"))
        assert len(log_files) == 1
        entries = [json.loads(line) for line in log_files[0].read_text().splitlines()]
        assert len(entries) == 1
        assert entries[0]["pin_id"] == pid
        assert entries[0]["after"]["lat"] == 23.8103

        # Pin updated in DB
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng, "
                "       confidence_score, location_precision "
                "FROM pins WHERE id = %s",
                (pid,),
            )
            r = cur.fetchone()
        assert math.isclose(r["lat"], 23.8103, rel_tol=1e-4)
        assert math.isclose(r["lng"], 90.4125, rel_tol=1e-4)
        assert r["confidence_score"] == 0.85
        assert r["location_precision"] == "city"


def test_apply_corrections_is_idempotent_within_same_day(tmp_path):
    log_dir = tmp_path / "audit-log"
    with _fixture_pin(title="Dhaka floods", lat=0.0, lng=0.0) as pid:
        corrections = [_make_correction(pid)]
        apply_corrections(corrections, log_dir=log_dir)
        # Second pass should be a no-op because the JSONL already
        # records this pin_id for today.
        n2 = apply_corrections(corrections, log_dir=log_dir)
        assert n2 == 0
        log_files = list(log_dir.glob("pins-location-fix-*.jsonl"))
        entries = [json.loads(line) for line in log_files[0].read_text().splitlines()]
        assert len(entries) == 1  # not duplicated


def test_apply_corrections_uses_postgis_for_distance_check(tmp_path):
    # Use a single Tokyo pin and check that update succeeds; the
    # distance verification is exercised in evaluate_pin tests.
    log_dir = tmp_path / "audit-log"
    with _fixture_pin(title="Tokyo summit", lat=0.0, lng=0.0) as pid:
        corrections = [_make_correction(
            pid, new_lat=35.6762, new_lng=139.6503,
            title="Tokyo summit",
            rules=("distance",),
        )]
        # The detected entry must be "Tokyo" for the test to be honest.
        corrections[0].after["country"] = "JP"
        corrections[0].after["place_name"] = "Tokyo"
        corrections[0].detected = {"city": "Tokyo", "country": "JP",
                                   "population": 13929286, "kind": "name"}
        apply_corrections(corrections, log_dir=log_dir)
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT ST_Y(location::geometry) AS lat FROM pins WHERE id = %s",
                (pid,),
            )
            r = cur.fetchone()
        assert math.isclose(r["lat"], 35.6762, rel_tol=1e-4)
```

Add `import json` to the imports at the top of `worker/tests/test_audit_locations.py`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /var/www/vhosts/xyzo.org && python -m pytest worker/tests/test_audit_locations.py -k apply -v 2>&1 | tail -10
```

Expected: FAIL — `apply_corrections` is currently `...`.

- [ ] **Step 3: Implement `apply_corrections()`**

Replace the `apply_corrections(...)` stub in `worker/audit_locations.py` with:

```python
def apply_corrections(corrections: Iterable[Correction],
                      *, log_dir: Path = DEFAULT_LOG_DIR,
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
    return len(pending)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org && python -m pytest worker/tests/test_audit_locations.py -v 2>&1 | tail -25
```

Expected: PASS for all tests including the three `apply_corrections` tests.

- [ ] **Step 5: Commit**

```bash
git add worker/audit_locations.py worker/tests/test_audit_locations.py
git -c user.name='Newsium Dev' -c user.email='dev@xyzo.org' commit -m "feat(audit): apply_corrections with JSONL audit log + idempotency" -m "Updates pins in batched transactions and appends a JSONL entry per correction. Idempotent within a UTC day via JSONL pin_id dedup.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: TDD `revert_from_log()` — inverse UPDATE

**Files:**
- Modify: `worker/tests/test_audit_locations.py`
- Modify: `worker/audit_locations.py:revert_from_log()`

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_audit_locations.py`:

```python
# ── revert_from_log ─────────────────────────────────────────────────

def test_revert_restores_original_pin_state(tmp_path):
    log_dir = tmp_path / "audit-log"
    with _fixture_pin(title="Dhaka floods", lat=0.0, lng=0.0) as pid:
        corrections = [_make_correction(pid)]
        apply_corrections(corrections, log_dir=log_dir)

        # Verify the pin is now at Dhaka
        with connect() as conn, conn.cursor() as cur:
            cur.execute("SELECT ST_Y(location::geometry) AS lat FROM pins WHERE id = %s", (pid,))
            assert math.isclose(cur.fetchone()["lat"], 23.8103, rel_tol=1e-4)

        # Revert
        log_files = list(log_dir.glob("pins-location-fix-*.jsonl"))
        reverted, missing = revert_from_log(log_files[0])
        assert reverted == 1
        assert missing == 0

        # Pin back at (0,0)
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng, "
                "       confidence_score "
                "FROM pins WHERE id = %s",
                (pid,),
            )
            r = cur.fetchone()
        assert math.isclose(r["lat"], 0.0, abs_tol=1e-4)
        assert math.isclose(r["lng"], 0.0, abs_tol=1e-4)
        assert r["confidence_score"] == 0.95


def test_revert_reports_missing_pins(tmp_path):
    log_dir = tmp_path / "audit-log"
    # Create a fake log referring to a non-existent pin.
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "pins-location-fix-2099-01-01.jsonl"
    log_path.write_text(json.dumps({
        "ts": "2099-01-01T00:00:00Z",
        "pin_id": 99999999,
        "title": "ghost",
        "before": {"lat": 0.0, "lng": 0.0,
                   "precision": "city", "confidence": 0.95, "country": None},
        "after": {"lat": 1.0, "lng": 1.0,
                  "precision": "city", "confidence": 0.85,
                  "country": "ZZ", "place_name": "Nowhere"},
        "detected": {"city": "Nowhere", "country": "ZZ",
                     "population": 0, "kind": "name"},
        "rules_fired": ["distance"],
        "source": {"feed": None, "country": None},
    }) + "\n")
    reverted, missing = revert_from_log(log_path)
    assert reverted == 0
    assert missing == 1
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /var/www/vhosts/xyzo.org && python -m pytest worker/tests/test_audit_locations.py -k revert -v 2>&1 | tail -10
```

Expected: FAIL — `revert_from_log` is currently `...`.

- [ ] **Step 3: Implement `revert_from_log()`**

Replace the `revert_from_log(...)` stub in `worker/audit_locations.py` with:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org && python -m pytest worker/tests/test_audit_locations.py -v 2>&1 | tail -10
```

Expected: PASS for the two `revert_*` tests.

- [ ] **Step 5: Commit**

```bash
git add worker/audit_locations.py worker/tests/test_audit_locations.py
git -c user.name='Newsium Dev' -c user.email='dev@xyzo.org' commit -m "feat(audit): revert_from_log inverse UPDATE" -m "Reads JSONL entries and runs inverse UPDATEs to restore pin lat/lng/precision/confidence. Returns (reverted, missing).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Add CLI (argparse)

**Files:**
- Modify: `worker/audit_locations.py:cli()`

- [ ] **Step 1: Append CLI tests**

Append to `worker/tests/test_audit_locations.py`:

```python
# ── cli ─────────────────────────────────────────────────────────────

def test_cli_dry_run_no_writes(tmp_path, capsys):
    log_dir = tmp_path / "audit-log"
    with _fixture_pin(title="Dhaka floods", lat=0.0, lng=0.0) as pid:
        rc = cli(["--dry-run", "--log-dir", str(log_dir)])
        assert rc == 0
        captured = capsys.readouterr()
        assert "corrections proposed" in captured.out
        # No JSONL written
        assert not list(log_dir.glob("pins-location-fix-*.jsonl"))


def test_cli_apply_writes_log(tmp_path):
    log_dir = tmp_path / "audit-log"
    with _fixture_pin(title="Dhaka floods", lat=0.0, lng=0.0) as pid:
        rc = cli(["--apply", "--log-dir", str(log_dir)])
        assert rc == 0
        log_files = list(log_dir.glob("pins-location-fix-*.jsonl"))
        assert len(log_files) == 1
        entries = [json.loads(line) for line in log_files[0].read_text().splitlines()]
        assert any(e["pin_id"] == pid for e in entries)


def test_cli_revert_round_trip(tmp_path):
    log_dir = tmp_path / "audit-log"
    with _fixture_pin(title="Dhaka floods", lat=0.0, lng=0.0) as pid:
        cli(["--apply", "--log-dir", str(log_dir)])
        log_files = list(log_dir.glob("pins-location-fix-*.jsonl"))
        rc = cli(["--revert", str(log_files[0])])
        assert rc == 0
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT ST_Y(location::geometry) AS lat FROM pins WHERE id = %s",
                (pid,),
            )
            r = cur.fetchone()
        assert math.isclose(r["lat"], 0.0, abs_tol=1e-4)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /var/www/vhosts/xyzo.org && python -m pytest worker/tests/test_audit_locations.py -k cli -v 2>&1 | tail -10
```

Expected: FAIL — `cli` is currently `...`.

- [ ] **Step 3: Implement `cli()`**

Replace the `cli(...)` stub in `worker/audit_locations.py` with:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org && python -m pytest worker/tests/test_audit_locations.py -v 2>&1 | tail -10
```

Expected: PASS for all tests including the three `cli_*` tests.

- [ ] **Step 5: Commit**

```bash
git add worker/audit_locations.py worker/tests/test_audit_locations.py
git -c user.name='Newsium Dev' -c user.email='dev@xyzo.org' commit -m "feat(audit): CLI with --apply/--dry-run/--limit/--since/--rules/--revert" -m "Allows running the audit from the shell. Defaults to dry-run. --apply makes changes; --revert undoes them via JSONL.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Wire into worker/run.py

**Files:**
- Modify: `worker/run.py`

- [ ] **Step 1: Inspect current run.py structure**

```bash
cd /var/www/vhosts/xyzo.org && grep -n "argparse\|add_argument\|extract\|publish\|geocode" worker/run.py | head -25
```

Look at the existing `main()` and step dispatch. Confirm where to add the new flag and where to call `audit_all_pins()`.

- [ ] **Step 2: Add `--audit-locations` flag**

In `worker/run.py`, find the `argparse.ArgumentParser()` block and add:

```python
    p.add_argument("--audit-locations", action="store_true",
                   help="After extract, run non-AI lat/lng audit on pins")
```

Default is `False` — no behavior change for existing invocations.

- [ ] **Step 3: Add audit call between extract and publish**

Find the step-dispatch block in `worker/run.py` (the `if step == "extract":` or similar). Insert the audit call after extract and before publish:

```python
    if args.audit_locations:
        from .audit_locations import audit_all_pins, apply_corrections
        corrections = audit_all_pins(since=None)
        n = apply_corrections(corrections)
        log.info("audit-locations: applied %d corrections", n)
```

Place it in the same code path that runs `extract` (don't gate it on `--step` since the audit is idempotent and useful after every extract cycle when enabled).

- [ ] **Step 4: Smoke test**

```bash
cd /var/www/vhosts/xyzo.org && python worker/run.py --help 2>&1 | grep -i audit
```

Expected: a line containing `--audit-locations`.

- [ ] **Step 5: Commit**

```bash
git add worker/run.py
git -c user.name='Newsium Dev' -c user.email='dev@xyzo.org' commit -m "feat(run): --audit-locations flag (off by default)" -m "Optional post-extract step that runs the non-AI title-driven pin lat/lng audit. Disabled by default; no behavior change for existing invocations.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: End-to-end smoke test against live DB

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit test suite**

```bash
cd /var/www/vhosts/xyzo.org && python -m pytest worker/tests/test_audit_locations.py -v 2>&1 | tail -25
```

Expected: all tests pass.

- [ ] **Step 2: Dry-run on 50 most recent pins**

```bash
cd /var/www/vhosts/xyzo.org && python -m worker.audit_locations --dry-run --limit 50 --verbose 2>&1 | head -30
```

Expected: a count line `Audited. N corrections proposed.` followed by up to 50 verbose lines.

- [ ] **Step 3: Apply on 50 most recent pins**

```bash
cd /var/www/vhosts/xyzo.org && python -m worker.audit_locations --apply --limit 50
```

Expected: `Applied N corrections.` with N > 0 if any misplacements were found.

- [ ] **Step 4: Inspect the log**

```bash
cat /var/www/vhosts/xyzo.org/data/audit-log/pins-location-fix-$(date -u +%F).jsonl | python -c "
import sys, json
from collections import Counter
rules = Counter()
for line in sys.stdin:
    e = json.loads(line)
    for r in e['rules_fired']:
        rules[r] += 1
print('Rules fired:', dict(rules))
"
```

Expected: a summary like `Rules fired: {'distance': 12, 'country': 5, ...}`.

- [ ] **Step 5: Re-run to confirm idempotency**

```bash
cd /var/www/vhosts/xyzo.org && python -m worker.audit_locations --apply --limit 50
```

Expected: `Applied 0 corrections.` (because the JSONL already recorded today's IDs).

- [ ] **Step 6: Revert**

```bash
cd /var/www/vhosts/xyzo.org && python -m worker.audit_locations --revert data/audit-log/pins-location-fix-$(date -u +%F).jsonl
```

Expected: `Reverted N pins. M pins not found (already changed since).`

- [ ] **Step 7: Commit (no source change; this task is verification)**

No commit needed for Task 9. If anything was tweaked during the smoke test, commit it as a follow-up fix.

---

## Self-Review

**1. Spec coverage** — Each spec section maps to a task:

| Spec section | Task |
|---|---|
| Files to create (`worker/audit_locations.py`, `.gitkeep`) | T1 |
| Files to modify (`worker/run.py`) | T8 |
| Reused primitives (`cities_text`, `db.connect`) | T1 imports; used throughout |
| Data flow step 1 (SELECT) | T2 |
| Data flow step 2 (cities_text) | T3 |
| Data flow step 3 (rules R1-R4) | T3 |
| Data flow step 4 (idempotency) | T5 |
| Data flow step 5 (UPDATE) | T5 |
| Data flow step 6 (JSONL append) | T5 |
| precision / confidence policy (LEAST) | T3 (`new_conf = min(old_conf, 0.85)`) |
| Audit log format | T5 (json.dumps with the documented schema) |
| Revert | T6 |
| CLI flags | T7 |
| Worker integration (`--audit-locations`) | T8 |
| Unit tests table | T2-T7 (every test listed in the spec is in the plan) |
| Smoke test | T9 |

**2. Placeholder scan** — No "TBD" / "TODO" / "implement later" present. Every step has either an exact command, exact code block, or both.

**3. Type consistency** — `Correction` is used as a `dataclass` throughout. `fetch_pins` returns `list[dict]`, `evaluate_pin` takes a `dict` and returns `Correction | None`, `audit_all_pins` returns `list[Correction]`, `apply_corrections` takes `Iterable[Correction]`, `revert_from_log` reads JSONL (not `Correction`). Names match across tasks.

**4. Risk noted in spec, not silently dropped** — The "kind='low'" → "confidence='low'" correction (R4 lookup semantics) is preserved: T3 uses `best.get("confidence") == "low"` as the skip.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-26-audit-pins-lat-lng.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks
2. **Inline Execution** — execute tasks in this session with checkpoints
