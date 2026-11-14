"""Science Universe Seeder — enrich news_sources + seed news_science_sources.

Targets: science sources in news_sources by domain match, inserts missing
candidates into news_science_sources with robots_status='pending'.

Run:
    python3 -m worker.science_sources_seeder
    python3 -m worker.science_sources_seeder --dry-run
"""
import json
import logging
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

from .db import connect

log = logging.getLogger("xyzo.science_seeder")

DATA_FILE = Path(__file__).parent / "science_sources_data.json"


def load_sources() -> list[dict]:
    try:
        with open(DATA_FILE) as f:
            raw = json.load(f)
        if isinstance(raw, list):
            return raw
        return raw.get("sources", raw.get("feeds", []))
    except (FileNotFoundError, json.JSONDecodeError) as e:
        log.error("Could not load %s: %s", DATA_FILE, e)
        return []


def extract_domain(url: str) -> str | None:
    try:
        host = urlparse(url).netloc.lower()
        return host.removeprefix("www.")
    except Exception:
        return None


def build_domain_pattern(domain: str) -> str:
    escaped = re.escape(domain)
    return f"https?://(www\\.)?{escaped}"


def run(dry_run: bool = False) -> dict:
    sources = load_sources()
    log.info("Loaded %d candidate sources", len(sources))

    with connect() as conn:
        rows = conn.execute("""
            SELECT id, feed_url, name, science_tier, science_focus
            FROM news_sources
            WHERE feed_url IS NOT NULL
              AND active = TRUE
        """).fetchall()

    existing = {extract_domain(r["feed_url"]): r for r in rows if extract_domain(r["feed_url"])}
    log.info("news_sources: %d rows, %d with parseable domains", len(rows), len(existing))

    stats = {"matched": 0, "updated": 0, "inserted": 0, "skipped": 0}

    with connect() as conn:
        for src in sources:
            domain = extract_domain(src.get("url") or src.get("feed_url") or "")
            if not domain:
                stats["skipped"] += 1
                continue

            domain = domain.removeprefix("www.")
            tier = int(src.get("science_tier", 4))
            focus = src.get("focus", "science")
            subfocus = src.get("subfocus", [])

            if domain in existing:
                row = existing[domain]
                current_tier = row.get("science_tier")
                current_focus = row.get("science_focus")
                should_update_tier = (
                    current_tier is None or current_tier > tier
                )
                should_update_focus = current_focus is None

                if should_update_tier or should_update_focus:
                    if dry_run:
                        log.info(
                            "  [dry-run] would update news_sources id=%d (%s): "
                            "tier %s→%s, focus %s→%s",
                            row["id"], domain,
                            current_tier, tier if should_update_tier else current_tier,
                            current_focus, focus if should_update_focus else current_focus,
                        )
                    else:
                        conn.execute("""
                            UPDATE news_sources SET
                                science_tier = LEAST(
                                    COALESCE(science_tier, 999), %s),
                                science_focus = COALESCE(science_focus, %s),
                                science_subfocus = COALESCE(science_subfocus, %s)
                            WHERE id = %s
                        """, (tier, focus, subfocus, row["id"]))
                    stats["updated"] += 1
                stats["matched"] += 1
            else:
                if dry_run:
                    log.info(
                        "  [dry-run] would insert into news_science_sources: "
                        "%s (%s, tier=%d, focus=%s)",
                        src["name"], domain, tier, focus
                    )
                else:
                    conn.execute("""
                        INSERT INTO news_science_sources (
                            name, domain, url, focus, subfocus, science_tier,
                            country, language, source_type, seed_source,
                            robots_status, has_rss, has_atom, has_sitemap
                        )
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'pending',
                                FALSE,FALSE,FALSE)
                        ON CONFLICT (domain) DO UPDATE SET
                            name         = EXCLUDED.name,
                            science_tier = LEAST(EXCLUDED.science_tier,
                                                 news_science_sources.science_tier),
                            focus        = COALESCE(EXCLUDED.focus,
                                                 news_science_sources.focus),
                            subfocus     = COALESCE(EXCLUDED.subfocus,
                                                 news_science_sources.subfocus),
                            updated_at   = NOW()
                    """, (
                        src["name"], domain, src.get("url", ""),
                        focus, subfocus, tier,
                        src.get("country", "US"), src.get("language", "en"),
                        src.get("source_type", "publication"), "science_seeder",
                    ))
                stats["inserted"] += 1

        if not dry_run:
            conn.commit()

    log.info(
        "science_seeder: matched=%d updated=%d inserted=%d skipped=%d",
        stats["matched"], stats["updated"], stats["inserted"], stats["skipped"]
    )
    return stats


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    dry = "--dry-run" in sys.argv
    if dry:
        log.setLevel(logging.INFO)
    result = run(dry_run=dry)
    print(json.dumps(result))
