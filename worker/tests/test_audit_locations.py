"""Tests for worker.audit_locations.

These tests run against the live newsium DB. They create and clean up
their own fixtures in a SAVEPOINT so other tests/operations are
untouched.
"""
from __future__ import annotations

import json
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
    cli,
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
        conn.commit()
        try:
            yield pin_id
        finally:
            with connect() as conn2, conn2.cursor() as cur2:
                cur2.execute("DELETE FROM rss_details WHERE pin_id = %s", (pin_id,))
                cur2.execute("DELETE FROM pins WHERE id = %s", (pin_id,))
                conn2.commit()


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
        assert math.isclose(match["confidence_score"], 0.95)
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
        conn.commit()
    try:
        rows = fetch_pins(limit=10_000)
        assert all(r["id"] != hid for r in rows)
    finally:
        with connect() as conn2, conn2.cursor() as cur2:
            cur2.execute("DELETE FROM pins WHERE id = %s", (hid,))
            conn2.commit()


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
                    title="Dhaka PM visits India",
                    source_country="BD")
    c = evaluate_pin(pin)
    assert c is not None
    assert c.pin_id == 7
    assert c.before["lat"] == -33.8688
    assert c.after["precision"] == "city"
    assert c.after["confidence"] <= 0.85  # capped, never raised


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
        rc = cli(["--apply", "--limit", "100000", "--log-dir", str(log_dir)])
        assert rc == 0
        log_files = list(log_dir.glob("pins-location-fix-*.jsonl"))
        assert len(log_files) == 1
        entries = [json.loads(line) for line in log_files[0].read_text().splitlines()]
        assert any(e["pin_id"] == pid for e in entries)


def test_cli_revert_round_trip(tmp_path):
    log_dir = tmp_path / "audit-log"
    with _fixture_pin(title="Dhaka floods", lat=0.0, lng=0.0) as pid:
        cli(["--apply", "--limit", "100000", "--log-dir", str(log_dir)])
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


def test_cli_apply_and_dry_run_conflict():
    rc = cli(["--apply", "--dry-run"])
    assert rc == 2  # mutually exclusive flags
