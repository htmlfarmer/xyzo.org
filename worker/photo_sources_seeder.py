"""Photo sources seeder — seeds photo_sources from photo_sources_data.json.

Mirrors the pattern from science_sources_seeder.py:
- Loads candidate sources from JSON
- Upserts into photo_sources table (ON CONFLICT on domain)
- Idempotent: safe to re-run
- Reports stats

Usage:
    python -m worker.photo_sources_seeder          # seed sources
    python -m worker.photo_sources_seeder --dry-run # preview without writing
"""
import json
import logging
from pathlib import Path

from .db import connect

log = logging.getLogger("xyzo.photo_sources_seeder")

PHOTO_SOURCES_FILE = Path(__file__).parent / "photo_sources_data.json"


def load_sources() -> list[dict]:
    """Load photo sources from photo_sources_data.json."""
    if not PHOTO_SOURCES_FILE.exists():
        log.error("photo_sources_data.json not found at %s", PHOTO_SOURCES_FILE)
        return []
    with PHOTO_SOURCES_FILE.open() as f:
        data = json.load(f)
    # Accept both list format and {"sources": [...]} format
    if isinstance(data, list):
        return data
    return data.get("sources", [])


def run(dry_run: bool = False) -> dict:
    """Seed photo_sources from JSON data.

    Args:
        dry_run: If True, don't write to database.

    Returns:
        Summary dict with counts.
    """
    sources = load_sources()
    if not sources:
        return {"total": 0, "inserted": 0, "updated": 0, "skipped": 0}

    summary = {"total": len(sources), "inserted": 0, "updated": 0, "skipped": 0}

    # Fetch existing domains for reporting
    existing_domains = set()
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT domain FROM photo_sources")
        existing_domains = {row["domain"] for row in cur.fetchall()}

    rows = []
    for s in sources:
        domain = s.get("domain", "").strip().lower()
        if not domain:
            log.warning("skipping source with no domain: %s", s.get("name"))
            summary["skipped"] += 1
            continue

        rows.append((
            s.get("name", ""),
            domain,
            s.get("url"),
            s.get("source_type", "photojournalism"),
            s.get("category", "global_photo"),
            s.get("country"),
            s.get("language", "en"),
            s.get("region"),
            s.get("audio_feed_url"),
            s.get("seed_source", "research_list"),
        ))

        if domain in existing_domains:
            summary["updated"] += 1
        else:
            summary["inserted"] += 1

    if dry_run:
        log.info("[dry-run] Would upsert %d photo sources (%d new, %d existing)",
                 len(rows), summary["inserted"], summary["updated"])
        return summary

    with connect() as conn, conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO photo_sources (
                name, domain, url, source_type, category,
                country, language, region, audio_feed_url, seed_source
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (domain) DO UPDATE SET
                name = EXCLUDED.name,
                url = EXCLUDED.url,
                source_type = EXCLUDED.source_type,
                category = EXCLUDED.category,
                country = EXCLUDED.country,
                language = EXCLUDED.language,
                region = EXCLUDED.region,
                audio_feed_url = COALESCE(EXCLUDED.audio_feed_url, photo_sources.audio_feed_url)
            """,
            rows,
        )
        conn.commit()

    log.info("photo_sources_seeder: upserted %d sources (%d new, %d updated, %d skipped)",
             len(rows), summary["inserted"], summary["updated"], summary["skipped"])

    # Print category breakdown
    cats = {}
    for s in sources:
        c = s.get("category", "unknown")
        cats[c] = cats.get(c, 0) + 1
    for c, n in sorted(cats.items()):
        log.info("  %s: %d", c, n)

    return summary


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Seed photo_sources from JSON")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    args = parser.parse_args()

    result = run(dry_run=args.dry_run)
    print(json.dumps(result, indent=2))
