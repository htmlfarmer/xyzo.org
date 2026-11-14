"""Contract tests for the wildlife source registry.

These pin the RULES, not the network: the registry must stay a truthful
record of what was probed, the importer must never carry a comment feed or
a podcast enclosure feed into the pipeline, and the two stores the
fetcher and the audit tooling read must not drift for these sources.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlparse

import pytest

from worker.wildlife_sources import (
    REGISTRY_PATH,
    REPORT_PATH,
    dedupe_rows,
    derive_skip_flags,
    feed_is_usable,
    load_registry,
)

REPO = Path(__file__).resolve().parents[2]
FEEDS_JSON = REPO / "worker" / "feeds.json"


# ── the registry file ─────────────────────────────────────────────────────

def test_registry_parses_and_has_entries():
    doc = json.loads(REGISTRY_PATH.read_text())
    assert doc["schema"] == "xyzo.wildlife_sources/1"
    sources = doc["sources"]
    assert len(sources) >= 100, "the registry must carry the candidate directory"

    ids = [s["id"] for s in sources]
    assert len(ids) == len(set(ids)), "registry ids must be unique"


def test_every_entry_has_the_required_metadata():
    for s in load_registry():
        assert s.get("name"), f"{s.get('id')} has no name"
        assert s.get("homepage", "").startswith("http"), f"{s['id']} has no homepage"
        assert s.get("feeds"), f"{s['id']} has no candidate feed"
        assert s.get("region"), f"{s['id']} has no region"
        assert s.get("language"), f"{s['id']} has no language"
        assert s.get("scope") in ("national", "regional", "international"), (
            f"{s['id']} has scope {s.get('scope')!r}"
        )
        # country is either a 2-letter ISO code or absent (global outlets)
        cc = s.get("country")
        assert cc is None or (isinstance(cc, str) and len(cc) == 2), (
            f"{s['id']} has country {cc!r}"
        )
        assert cc != "ME", f"{s['id']} uses 'ME' (ISO Montenegro) as a region"


def test_live_entries_are_wildlife_or_general_scoped():
    for s in load_registry():
        assert s.get("feed_scope") in ("wildlife", "general"), (
            f"{s['id']} has no feed_scope"
        )
        assert s.get("topic"), f"{s['id']} has no topic"
        assert s.get("topics"), f"{s['id']} has no topics"


def test_skipped_entries_carry_a_reason():
    for s in load_registry():
        if s.get("skip"):
            assert s.get("skip_reason"), (
                f"{s['id']} is skipped without a reason — the flag is derived, "
                "so a missing reason means it was hand-edited"
            )


# ── the feed filters ──────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "row",
    [
        {"feed_url": "https://x.org/comments/feed/", "feed_title": "Some Blog"},
        {"feed_url": "https://x.org/feed/podcast", "feed_title": "A Podcast"},
        {"feed_url": "https://x.org/feed/", "feed_title": "Comments on: A post"},
        {"feed_url": "https://x.org/feed/", "feed_title": "Comments are closed"},
    ],
)
def test_comment_and_podcast_feeds_are_rejected(row):
    ok, why = feed_is_usable(row)
    assert not ok, f"{row} should have been rejected"
    assert why


def test_a_real_feed_is_accepted():
    ok, why = feed_is_usable(
        {"feed_url": "https://x.org/feed/", "feed_title": "Wildlife Conservation Trust"}
    )
    assert ok, why


def test_dedupe_keeps_one_row_per_feed_url():
    rows = [
        {"feed_url": "https://a.org/feed/", "name": "Low priority", "priority": 6, "entries": 3},
        {"feed_url": "https://a.org/feed/", "name": "High priority", "priority": 1, "entries": 9},
        {"feed_url": "https://b.org/feed/", "name": "Other", "priority": 3, "entries": 5},
    ]
    kept, dropped = dedupe_rows(rows)
    assert len(kept) == 2
    assert len(dropped) == 1
    names = {r["name"] for r in kept}
    assert "High priority" in names
    assert "Low priority" not in names


# ── the derived skip flags ────────────────────────────────────────────────

def test_derive_skip_flags_flags_the_failures_only():
    sources = [
        {"id": "good", "name": "Good"},
        {"id": "bad", "name": "Bad"},
        {"id": "portal", "name": "Portal", "data_portal": True, "note": "a data portal"},
    ]
    report = {
        "results": [
            {"id": "good", "ok": True, "feed_url": "https://good.org/feed/"},
            {"id": "bad", "ok": False, "robots_allowed": None},
            {"id": "portal", "ok": False, "robots_allowed": None},
        ]
    }
    reasons = derive_skip_flags(sources, report)
    assert "good" not in reasons
    assert "no working RSS feed" in reasons["bad"]
    assert reasons["portal"] == "a data portal"


# ── the probe report ──────────────────────────────────────────────────────

@pytest.mark.skipif(not REPORT_PATH.exists(), reason="no probe report yet")
def test_every_working_feed_in_the_report_has_entries():
    report = json.loads(REPORT_PATH.read_text())
    for row in report["results"]:
        if row.get("ok"):
            assert row.get("feed_url"), f"{row['id']} is ok but has no feed_url"
            assert row.get("entries", 0) > 0, (
                f"{row['id']} is marked ok with {row.get('entries')} entries"
            )
            assert row.get("robots_allowed") is not False, (
                f"{row['id']} is marked ok but robots disallowed it"
            )


@pytest.mark.skipif(not REPORT_PATH.exists(), reason="no probe report yet")
def test_the_report_covers_the_whole_registry():
    report = json.loads(REPORT_PATH.read_text())
    registry_ids = {s["id"] for s in load_registry()}
    report_ids = {r["id"] for r in report["results"]}
    assert registry_ids - report_ids == set(), (
        "every registry candidate must have a probe verdict"
    )


# ── the database ──────────────────────────────────────────────────────────

def _db():
    dsn = (
        os.environ.get("XYZO_DB_DSN")
        or os.environ.get("XYZO_DB_URL")
        or os.environ.get("DATABASE_URL")
    )
    if not dsn:
        env = REPO / "api" / ".env"
        if env.exists():
            for line in env.read_text().splitlines():
                if line.startswith("XYZO_DB_URL="):
                    dsn = line.split("=", 1)[1].strip().strip('"')
                    break
    if not dsn:
        pytest.skip("no database DSN")
    return dsn


def test_imported_wildlife_sources_have_a_country_or_a_coverage_role():
    """A country-less wildlife source must be marked as a regional or
    international outlet.

    The country drives the single-city source fallback. A publisher whose
    output covers a whole region has no single country, and giving it one
    pins every one of its stories to that country's capital (the Bamako
    pileup). Those rows carry country=NULL plus the coverage role in
    `locality`; the article is then placed from its own text or left
    unlocated, which is the honest outcome.
    """
    import psycopg

    with psycopg.connect(_db()) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, name, country, region, locality FROM news_sources
             WHERE deleted_at IS NULL AND active
               AND topics IS NOT NULL
               AND (country IS NULL OR country = '')
               AND LOWER(COALESCE(region, '')) NOT IN ('mena', 'global')
               AND LOWER(COALESCE(locality, '')) NOT IN ('regional', 'international')
            """
        )
        missing = cur.fetchall()
    assert not missing, (
        f"{len(missing)} active wildlife sources have no country and are not "
        "marked as a regional/global outlet"
    )


def test_national_wildlife_sources_carry_their_country():
    """A national agency IS placeable: it publishes about its own country."""
    import psycopg

    with psycopg.connect(_db()) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, name FROM news_sources
             WHERE deleted_at IS NULL AND active
               AND topics IS NOT NULL
               AND LOWER(COALESCE(locality, '')) = 'national'
               AND (country IS NULL OR country = '')
            """
        )
        rows = cur.fetchall()
    assert not rows, (
        f"{len(rows)} national wildlife sources have no country — their "
        "articles would never be placed"
    )


def test_no_duplicate_publisher_rows():
    """One publisher, one row.

    `snowleopard.org` and `www.snowleopardtrust.org` are the SAME
    organisation; the non-www Hakai feed and the WOAH `/en/feed/` carry the
    same documents as their siblings. Two rows means the same story lands on
    the map twice.
    """
    import psycopg

    with psycopg.connect(_db()) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT name, feed_url FROM news_sources
             WHERE deleted_at IS NULL AND active AND topics IS NOT NULL
            """
        )
        rows = cur.fetchall()

    def normalise(url: str) -> str:
        u = url.strip().lower().rstrip("/")
        if u.startswith("https://www."):
            u = u[len("https://www."):]
        elif u.startswith("http://www."):
            u = u[len("http://www."):]
        return u

    seen: dict[str, str] = {}
    dupes: list[str] = []
    for name, url in rows:
        key = normalise(url)
        if key in seen and seen[key] != name:
            dupes.append(f"{seen[key]} and {name} both use {url}")
        seen.setdefault(key, name)
    assert not dupes, "the same feed is ingested twice: " + "; ".join(dupes)


def test_known_same_publisher_aliases_are_not_ingested_twice():
    """The aliases that bit us once, pinned by name."""
    import psycopg

    with psycopg.connect(_db()) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT name FROM news_sources
             WHERE deleted_at IS NULL AND active AND topics IS NOT NULL
               AND (feed_url ILIKE '%snowleopard.org%'
                 OR feed_url ILIKE '%hakaimagazine.com%'
                 OR feed_url ILIKE '%woah.org/en/feed%')
            """
        )
        rows = [r[0] for r in cur.fetchall()]
    assert len(rows) <= 2, (
        f"the same publisher is ingested under two aliases: {rows}"
    )


def test_no_comment_or_podcast_feed_reached_the_database():
    import psycopg

    with psycopg.connect(_db()) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT name, feed_url FROM news_sources
             WHERE deleted_at IS NULL
               AND (feed_url LIKE '%/comments/feed%'
                 OR feed_url LIKE '%/comment/feed%'
                 OR feed_url LIKE '%/feed/podcast%'
                 OR feed_url LIKE '%/podcast/feed%')
            """
        )
        rows = cur.fetchall()
    assert not rows, f"comment/podcast feeds reached news_sources: {rows}"


def test_the_two_stores_agree_for_the_wildlife_sources():
    import psycopg

    feeds = json.loads(FEEDS_JSON.read_text())["feeds"]
    feed_urls = {f["feed_url"] for f in feeds}
    with psycopg.connect(_db()) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT feed_url FROM news_sources
             WHERE deleted_at IS NULL AND topic = 'wildlife'
            """
        )
        db_urls = {r[0] for r in cur.fetchall()}
    assert db_urls, "no wildlife-tagged sources in the database"
    missing = db_urls - feed_urls
    assert not missing, (
        f"{len(missing)} wildlife sources are missing from worker/feeds.json — "
        "the audit tooling cannot see them"
    )


def test_the_seed_path_cannot_degrade_a_country():
    """`worker.run --seed-feeds` must not blank a row's country.

    A feeds.json entry with `country: ""` and `region: "unknown"` used to
    overwrite a row's real country ('GB' for New Scientist, 'US' for
    ScienceDaily) — and the placement gate then rejected the row as "a
    source with no country that is not marked regional/global". The seed
    path is a fill-in, never a downgrade.
    """
    import psycopg

    feeds = json.loads(FEEDS_JSON.read_text())["feeds"]
    blank = {
        f["feed_url"]
        for f in feeds
        if not (f.get("country") or "").strip()
        and (f.get("region") or "").strip() in ("", "unknown")
    }
    if not blank:
        pytest.skip("no blank-country entries in feeds.json")

    with psycopg.connect(_db()) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT feed_url, name, country, region FROM news_sources
             WHERE deleted_at IS NULL AND feed_url = ANY(%s)
            """,
            (list(blank),),
        )
        rows = cur.fetchall()
    broken = [
        (r[1], r[2], r[3]) for r in rows if not (r[2] or "").strip()
    ]
    assert not broken, (
        "these feeds carry an empty country in feeds.json AND in the database: "
        f"{broken} — the seed path would keep them empty"
    )
