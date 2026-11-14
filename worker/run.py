"""xyzo.org — event-centric ingestion orchestrator.

IMPORTANT — crash recovery: fetch.run() calls cleanup_stale_leases() on every
startup. After a server reboot, any source that was mid-fetch when the machine
died is immediately marked reclaimable (fetch_in_progress=FALSE, lease cleared).
No need to wait 5 minutes for the lease TTL to expire.

Run modes:
  python -m worker.run                       full cycle (fetch → extract → geocode → cluster)
  python -m worker.run --seed-feeds          upsert feeds from feeds.json and exit
  python -m worker.run --limit 30            cap AI extraction to N articles per cycle
  python -m worker.run --dry-run             fetch + extract only, no commits to db
  python -m worker.run --step fetch          run a single step
  python -m worker.run --search "Chicago"    re-fetch, then return events matching "Chicago"
                                             (headline OR location place_name or country)

Search mode is what the API calls when a user types a place into the
search bar. It re-runs the full pipeline (honoring ETag) and then queries
news_events for matches. Designed to be invoked synchronously by the API
endpoint with a 90-second budget.
"""
import argparse
import json
import logging
import os
import sys
import time

from . import fetch, extract, geocode, cluster, re_evaluate, learn, auto_categorize
from . import audio_fetch, audio_extract, audio_geocode


def is_paused() -> bool:
    """Check if the worker should pause/stop.

    Controlled via XYZX_PAUSED=1 environment variable. Useful during development
    when you want to stop the worker from processing new items without
    disabling the entire service.

    Usage:
        # Stop worker from processing
        XYZX_PAUSED=1 systemctl restart xyzo-fast-fetcher

        # Worker will exit immediately on next cycle
    """
    return os.environ.get("XYZX_PAUSED", "0") == "1"


def check_pause(step_name: str) -> bool:
    """Check if paused and log. Returns True if paused (caller should skip step)."""
    if is_paused():
        log.warning("worker.run: paused (%s skipped) — set XYZX_PAUSED=0 to resume", step_name)
        return True
    return False
from . import video_fetch, video_transcript, video_extract, video_linker, video_geocode, video_site_crawler
from . import sysload
from .progress import ProgressWriter

log = logging.getLogger("xyzo.run")


def _search_events(query: str, since_run_id: int | None = None) -> list[dict]:
    """Return events whose headline, place_name, or country ILIKE %query%."""
    if not query or not query.strip():
        return []
    like = f"%{query.strip()}%"
    sql = """
        SELECT e.id, e.event_type, e.headline, e.summary,
               e.first_reported_at, e.source_count, e.relevance_days, e.expires_at,
               l.lat, l.lng, l.place_name, l.country, l.precision
        FROM news_events e
        LEFT JOIN news_locations l ON l.id = e.primary_location_id
        WHERE (e.headline ILIKE %s ESCAPE '\\'
            OR e.summary  ILIKE %s ESCAPE '\\'
            OR l.place_name ILIKE %s ESCAPE '\\'
            OR l.country   ILIKE %s ESCAPE '\\')
          AND (e.expires_at IS NULL OR e.expires_at > now())
    """
    if since_run_id is not None:
        sql += " AND e.id >= %s"
    sql += " ORDER BY e.first_reported_at DESC, e.id DESC LIMIT 30"
    with cluster.connect() as conn, conn.cursor() as cur:
        params: tuple = (like, like, like, like)
        if since_run_id is not None:
            params = params + (since_run_id,)
        cur.execute(sql, params)
        return list(cur.fetchall())


def main() -> int:
    p = argparse.ArgumentParser(description="xyzo event ingestion")
    p.add_argument("--seed-feeds", action="store_true", help="upsert feeds from feeds.json and exit")
    p.add_argument("--limit", type=int, default=60, help="cap AI extraction per cycle (default 60)")
    p.add_argument("--dry-run", action="store_true", help="fetch + extract only, skip cluster and DB writes")
    p.add_argument("--step", choices=["fetch", "auto_categorize", "extract", "geocode", "cluster", "learn", "audio_fetch", "audio_extract", "audio_geocode", "video_fetch", "video_transcript", "video_extract", "video_linker", "video_geocode", "video_site_crawl", "all"], default="all")
    p.add_argument("--search", type=str, default=None, help="after cycle, return events matching this query")
    p.add_argument("--fast", action="store_true",
                   help="fast cycle: fetch + auto_categorize + geocode + cluster only (skip AI extract + learn)")
    p.add_argument("--re-evaluate-request", type=int, default=None,
                   help="process a single queued re-evaluation request by id, then exit")
    p.add_argument("--quiet", action="store_true", help="warnings only")
    p.add_argument("--audit-locations", action="store_true",
                   help="After extract, run non-AI lat/lng audit on pins")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    if args.seed_feeds:
        n = fetch.seed_sources()
        log.info("seeded %d feeds", n)
        n_audio = audio_fetch.seed_audio_shows()
        log.info("seeded %d audio shows", n_audio)
        return 0

    # Process a single re-evaluation request, then exit. Spawned by the
    # API for each /api/pins/:id/{re-evaluate,suggest-coords} call.
    if args.re_evaluate_request is not None:
        summary = re_evaluate.run_one(args.re_evaluate_request)
        json.dump(summary, sys.stdout, default=str)
        sys.stdout.write("\n")
        return 0

    # Cooperative CPU load guard (worker/load_guard.py): a watchdog sets
    # data/load_pause when the machine saturates; scheduled pipeline cycles
    # skip politely (exit 0) instead of piling onto a box that is already
    # begging. User-facing work (search, re-evaluate, seed) still runs.
    from .load_guard import pause_reason, should_pause
    if not args.search and should_pause():
        log.warning("load guard: skipping pipeline cycle — %s", pause_reason())
        return 0

    t0 = time.time()
    if args.search:
        # Search is a synchronous API call — we have 90s budget. The full
        # pipeline (fetch + auto_categorize + extract + geocode + cluster) can
        # easily exceed that when the backlog is large, so just query the DB.
        # The scheduled cron run handles keeping the pipeline current.
        steps = []
        log.info("search mode: skipping pipeline, querying events directly for %r", args.search)
    elif args.fast:
        # Fast mode: skip AI extract and learn. Just fetch, parse, geocode, cluster.
        steps = ["fetch", "auto_categorize", "geocode", "cluster"]
    elif args.step != "all":
        steps = [args.step]
    else:
        # Check system load to decide whether to include AI extraction.
        load = sysload.snapshot()
        log.info("sysload: mode=%s cpu_idle=%.0f%% gpu_util=%.0f%% gpu_mem=%.0f%%",
                 load.mode, load.cpu_idle_pct, load.gpu_util_pct, load.gpu_mem_pct)

        if load.mode == "throttle":
            # System under heavy load — fast-path only, skip AI + learn.
            log.info("sysload: throttled — skipping AI extract, running fast-path only")
            steps = ["fetch", "auto_categorize", "geocode", "cluster"]
        elif load.mode == "cpu_only":
            # GPU busy but CPU free — run AI with reduced limit (regex fallback
            # will handle most articles, AI catches what it can in the gaps).
            log.info("sysload: GPU busy — AI extract with reduced limit, regex fallback active")
            steps = ["fetch", "auto_categorize", "extract", "geocode", "cluster"]
            # Reduce AI limit when GPU is busy — let the circuit breaker
            # and sysload.ai_allowed() handle the rest.
            args.limit = min(args.limit, 20)
        else:
            # Full mode: GPU available, run everything.
            steps = ["fetch", "auto_categorize", "extract", "geocode", "cluster"]

        # Always close the loop with a learning pass after a full cycle.
        # Search mode is handled above and never reaches here.
        steps.append("learn")

        # Audio pipeline runs alongside text pipeline (independent feeds)
        steps.append("audio_fetch")
        steps.append("audio_extract")
        steps.append("audio_geocode")

        # Video pipeline — DISABLED to reduce I/O load
        # Keeping step available for manual --step video_fetch, etc.
        # steps.extend(["video_fetch", "video_transcript", "video_linker", "video_geocode", "video_site_crawl"])
    summary: dict = {"steps": {}, "search_query": args.search}

    # When the API spawned us for an auto-discover pass it sets
    # NEWSIUM_AREA_REQUEST_ID and NEWSIUM_DISCOVERY_STATUS_FILE — wire a
    # shared progress writer that the API will read on every poll. When
    # those env vars are missing (scheduled cron run, manual CLI, tests)
    # progress is None and the workers skip the update hooks.
    request_id_env = os.environ.get("NEWSIUM_AREA_REQUEST_ID")
    progress = ProgressWriter.from_env(int(request_id_env)) if request_id_env else None
    if progress:
        progress.update(step="fetch", detail="Starting discovery...")
        log.info("auto-discover progress writer attached: %s",
                 os.environ.get("NEWSIUM_DISCOVERY_STATUS_FILE"))

    # Development pause check — skip all steps if XYZX_PAUSED=1
    if is_paused():
        log.warning("worker.run: paused — XYZX_PAUSED=1 set, skipping all steps. "
                    "Set XYZX_PAUSED=0 to resume.")
        return 0

    if "fetch" in steps:
        summary["steps"]["fetch"] = fetch.run(limit=50, progress=progress)

    if "auto_categorize" in steps:
        # No limit — fast path is cheap. auto_categorize.run(0) means
        # drain the pending queue, same convention extract uses.
        summary["steps"]["auto_categorize"] = auto_categorize.run(limit=0, progress=progress)

    if "extract" in steps:
        summary["steps"]["extract"] = extract.run(limit=args.limit, progress=progress)

    if "geocode" in steps and not args.dry_run:
        # In search mode, cap geocode to this run's article batch so we don't
        # burn minutes draining the backlog; the scheduled run handles that.
        # In auto-discover (env NEWSIUM_AREA_REQUEST_ID set) we drain
        # everything so every newly-extracted article is geocoded.
        if progress is not None:
            geo_limit = 0  # unlimited → drain
        else:
            geo_limit = args.limit if args.search else 300
        # Audit 3+4 — the synchronous per-article geocoder stalled the
        # fetch pipeline. ``run_parallel`` (worker/geocode.py) fans the
        # batch out through a ThreadPoolExecutor with a shared Nominatim
        # rate limiter; DB upserts and the next Nominatim RTT overlap.
        # Opt-out env var preserves the legacy serial path for any
        # operator that prefers it (e.g. debugging).
        if os.environ.get("NEWSIUM_GEOCODE_LEGACY") == "1":
            log.info("geocode: using legacy serial path (NEWSIUM_GEOCODE_LEGACY=1)")
            summary["steps"]["geocode"] = geocode.run(limit=geo_limit, progress=progress)
        else:
            summary["steps"]["geocode"] = geocode.run_parallel(
                limit=geo_limit or geocode.MAX_PER_CYCLE,
                progress=progress,
            )

    if "cluster" in steps and not args.dry_run:
        summary["steps"]["cluster"] = cluster.run(limit=max(args.limit * 10, 5000))

    if args.audit_locations and not args.dry_run:
        # Optional post-cluster audit: detect pin misplacements via non-AI
        # title matching and rewrite lat/lng with a JSONL audit log.
        from .audit_locations import audit_all_pins, apply_corrections
        corrections = audit_all_pins(since=None)
        n = apply_corrections(corrections)
        summary["steps"]["audit_locations"] = {"applied": n}
        log.info("audit-locations: applied %d corrections", n)

    if "learn" in steps and not args.dry_run:
        # Close the loop: observe outcomes, update source priorities,
        # log coverage gaps and extraction issues for next cycle.
        summary["steps"]["learn"] = learn.run_all()

    # ── Audio pipeline ──────────────────────────────────────────────
    if "audio_fetch" in steps and not args.dry_run:
        summary["steps"]["audio_fetch"] = audio_fetch.run()

    if "audio_extract" in steps and not args.dry_run:
        summary["steps"]["audio_extract"] = audio_extract.run(limit=args.limit)

    if "audio_geocode" in steps and not args.dry_run:
        summary["steps"]["audio_geocode"] = audio_geocode.run(limit=300)

    # ── Video pipeline ──────────────────────────────────────────────
    if "video_fetch" in steps and not args.dry_run:
        summary["steps"]["video_fetch"] = video_fetch.run()

    if "video_transcript" in steps and not args.dry_run:
        summary["steps"]["video_transcript"] = video_transcript.run()

    if "video_extract" in steps and not args.dry_run:
        summary["steps"]["video_extract"] = video_extract.run(limit=args.limit)

    if "video_linker" in steps and not args.dry_run:
        summary["steps"]["video_linker"] = video_linker.run_batch()

    if "video_geocode" in steps and not args.dry_run:
        summary["steps"]["video_geocode"] = video_geocode.run()

    if "video_site_crawl" in steps and not args.dry_run:
        summary["steps"]["video_site_crawl"] = video_site_crawler.run_batch(limit=5)

    summary["duration_s"] = round(time.time() - t0, 1)
    summary["sysload"] = sysload.status_dict()

    if args.search:
        matches = _search_events(args.search)
        summary["search_matches"] = len(matches)
        summary["events"] = [
            {
                "id": int(e["id"]),
                "event_type": e["event_type"],
                "headline": e["headline"],
                "summary": e.get("summary"),
                "first_reported_at": e["first_reported_at"].isoformat() if e.get("first_reported_at") else None,
                "source_count": int(e.get("source_count") or 0),
                "relevance_days": int(e.get("relevance_days") or 7),
                "expires_at": e["expires_at"].isoformat() if e.get("expires_at") else None,
                "location": (
                    {
                        "lat": float(e["lat"]),
                        "lng": float(e["lng"]),
                        "place_name": e.get("place_name"),
                        "country": e.get("country"),
                        "precision": e.get("precision"),
                    }
                    if e.get("lat") is not None and e.get("lng") is not None
                    else None
                ),
            }
            for e in matches
        ]

    log.info("cycle done: %s", summary)
    if progress:
        auto = summary["steps"].get("auto_categorize", {})
        progress.finish(
            step="complete",
            detail=(f"Done. {auto.get('fast_path_high', 0)} fast-path high + "
                   f"{auto.get('fast_path_medium', 0)} med + "
                   f"{auto.get('source_fallback', 0)} src-fb, "
                   f"{summary['steps'].get('extract', {}).get('extracted', 0)} AI-extracted, "
                   f"{summary['steps'].get('geocode', {}).get('geocoded', 0)} geocoded."),
        )
    json.dump(summary, sys.stdout, default=str)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
