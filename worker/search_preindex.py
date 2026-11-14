#!/usr/bin/env python3
"""search_preindex.py — build the pre-index of popular searches.

A text search is the slowest thing on the site: it ranks with
ts_rank_cd over the whole corpus. After the index fixes of 2026-11-11 a
cold search measures 0.5-2 s — good, but still a database query per
reader, over a corpus that grows every minute.

This worker answers the popular queries IN ADVANCE: it asks the API for
the answer to each candidate query, stores it with the time it was
built, and the API serves the stored answer instead of running the
query again. A reader gets the answer in ~100 ms; the live query keeps
running behind it and the answer says how old it is.

WHY IT CALLS THE API INSTEAD OF RUNNING THE SQL. The search SQL lives
in api/src/routes/pins.ts. A second copy of it here would be a second
implementation, and the second implementation is the one that drifts —
the ranking, the whole-word rule and the expansion terms would all have
to be kept in step by hand. Asking our own endpoint means the stored
answer is BYTE-FOR-BYTE the answer a live reader gets.

WHAT IS STORED IS THE ANSWER, NOT THE STORIES. The payload holds the
pin list as the API serves it, slimmed of word_freq (711 KB of a
1.5 MB answer; the popup fetches its keywords on demand from
/api/pins/:id/words — the same slimming the browser-side
saved-searches store already does). The ARTICLES are never copied: a
stored answer points at live rows, so a title, an image and a timestamp
are always current. Only the SELECTION is precomputed.

THE KEY CARRIES THE TIME WINDOW, NOT THE TIMESTAMP. "24h" is asked for
as `since=<now - 24h, snapped to the minute>`, so a key built from the
timestamp would change every minute and the stored answer would never
be found again. The window is a label ("24h", "7d", "all") and the key
is `query | window | tag | limit`.

WHICH QUERIES. Three sources, in this order:
  1. what readers actually searched (search_query_stats, written by the
     search path itself);
  2. the observed log (news_search_log);
  3. the SEED list — the places people search for (worker/data/
     search_seed_queries.json): the largest cities of the world by
     population, the countries, and the topics that dominate the log.

Run:
    python3 -m worker.search_preindex --build          # one pass
    python3 -m worker.search_preindex --build --limit 200
    python3 -m worker.search_preindex --stats
    python3 -m worker.search_preindex --verify          # is the store fresh?
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from worker.db import connect  # noqa: E402

# ── configuration ───────────────────────────────────────────────────────
API_BASE = os.environ.get("XYZO_API_BASE", "http://localhost:3008")
SEED_PATH = Path(__file__).resolve().parent / "data" / "search_seed_queries.json"

# The windows the pre-index holds. "24h" is the site's DEFAULT time
# filter (app.js: `let timeFilter = "24h"`), so it is the one that
# matters; "all" is the second (the reader's "Show All" button).
WINDOWS = ["24h", "all"]

# How long a stored answer stays servable. The refresh cycle is minutes,
# so an hour-old entry is being rewritten as you read this; six hours is
# the point at which the refresh has clearly failed and the answer must
# not be served at all.
MAX_AGE_HOURS = 6

# The reader's default limit is 500 for /api/pins and 1,000 for the
# search path; both are stored, because they are different answers.
LIMITS = [1000, 500]

# One entry is ~40 KB slimmed, so a thousand of them is ~40 MB.
MAX_ENTRIES = 4000


def log(msg: str) -> None:
    print(f"[search-preindex] {msg}", flush=True)


def since_for(window: str, now: float | None = None) -> str | None:
    """The `since` the frontend would send for this window.

    Mirrors getSinceDate() in public_html/app.js — including the 60-second
    snap, because the key is the WINDOW and not the timestamp (the snap
    only has to be close enough for the window to be derived).
    """
    if window == "all":
        return None
    now_ms = int((now if now is not None else time.time()) * 1000)
    snapped = (now_ms // 60000) * 60000
    days = 1
    if window.endswith("d"):
        days = int(window[:-1])
    elif window.startswith("custom:"):
        days = int(window.split(":", 1)[1])
    import datetime as _dt

    return _dt.datetime.fromtimestamp((snapped - days * 86400000) / 1000, _dt.timezone.utc).isoformat().replace("+00:00", "Z")


def api_get(path: str, params: dict, timeout: int = 120) -> dict | None:
    url = f"{API_BASE}{path}?{urllib.parse.urlencode(params)}"
    # X-Search-Fresh: the builder must get the LIVE answer. The query it
    # asks for is usually ALREADY in the pre-index, and without this the
    # API would hand back the stored answer — so the builder would copy
    # the old answer over itself and the store would never get fresher.
    req = urllib.request.Request(
        url, headers={"User-Agent": "xyzo-search-preindex/1.0", "X-Search-Fresh": "1"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if r.status != 200:
                return None
            return json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
        log(f"request failed: {path} {params.get('q')!r}: {e}")
        return None


def slim(payload: dict) -> dict:
    """Drop word_freq — 711 KB of a 1.5 MB answer.

    The popup fetches its keywords on demand from /api/pins/:id/words,
    and the browser-side saved-searches store already stores the slimmed
    shape and paints it through the same renderPins().
    """
    pins = payload.get("pins") or []
    out = []
    for p in pins:
        if isinstance(p, dict) and "word_freq" in p:
            p = {k: v for k, v in p.items() if k != "word_freq"}
        out.append(p)
    return {
        "pins": out,
        "next_cursor": payload.get("next_cursor"),
        "has_more": payload.get("has_more", False),
    }


def query_key(query: str, window: str, tag: str, limit: int) -> str:
    import unicodedata

    def norm(s: str) -> str:
        s = unicodedata.normalize("NFD", s or "")
        s = "".join(c for c in s if not unicodedata.combining(c))
        return " ".join(s.lower().split())

    return f"{norm(query)}|{window}|{norm(tag)}|{limit}"


def load_seed() -> list[str]:
    try:
        data = json.loads(SEED_PATH.read_text())
        return [str(x) for x in data.get("queries", []) if str(x).strip()]
    except Exception as e:  # pragma: no cover
        log(f"seed list unavailable ({e})")
        return []


def candidates(limit: int) -> list[str]:
    """The queries worth precomputing: real demand first, then the seed."""
    out: list[str] = []
    seen: set[str] = set()

    def add(q: str) -> None:
        q = (q or "").strip()
        if len(q) < 2 or q.lower() in seen:
            return
        seen.add(q.lower())
        out.append(q)

    try:
        with connect() as conn:
            rows = conn.execute(
                """
                SELECT query FROM search_query_stats
                ORDER BY use_count DESC, last_used_at DESC
                LIMIT %s
                """,
                (limit,),
            ).fetchall()
            for r in rows:
                add(r["query"])
            # The observed log, for the queries that pre-date the stats table.
            rows = conn.execute(
                """
                SELECT lower(trim(query)) AS q, count(*) AS n
                FROM news_search_log
                WHERE created_at > now() - interval '60 days'
                GROUP BY 1 ORDER BY n DESC
                LIMIT %s
                """,
                (limit,),
            ).fetchall()
            for r in rows:
                add(r["q"])
    except Exception as e:
        log(f"candidate query failed: {e}")

    for q in load_seed():
        add(q)
        if len(out) >= limit:
            break
    return out[:limit]


def stored_ages() -> dict[str, float]:
    """query_key -> age in seconds, for every stored entry."""
    out: dict[str, float] = {}
    try:
        with connect() as conn:
            rows = conn.execute(
                "SELECT query_key, EXTRACT(EPOCH FROM (now() - built_at)) AS age FROM search_preindex"
            ).fetchall()
        now = time.time()
        for r in rows:
            out[r["query_key"]] = now - float(r["age"])
    except Exception as e:
        log(f"age lookup failed: {e}")
    return out


def build(
    limit: int,
    windows: list[str] | None = None,
    dry_run: bool = False,
    min_age_minutes: int = 30,
    full: bool = False,
    limits: list[int] | None = None,
    sleep: float = 2.0,
    max_entries: int = 0,
) -> dict:
    windows = windows or WINDOWS
    limits = limits or LIMITS
    queries = candidates(limit)
    log(f"{len(queries)} candidate queries, windows={windows}, limits={limits}")
    if dry_run:
        for q in queries[:20]:
            log(f"  would build: {q!r}")
        return {"candidates": len(queries), "built": 0}

    built = 0
    failed = 0
    skipped = 0
    t0 = time.time()
    # THE BUILDER IS A POLITE CITIZEN.
    #
    # Every entry is one heavy search query (the ranking runs over the
    # whole corpus), so a thousand of them back-to-back is a thousand
    # seconds of DATABASE TIME — and the reader's map load is the same
    # database. Measured 2026-11-12: the builder running flat-out took
    # the box to load average 23, and a friend's map took MINUTES to
    # draw its markers while it did.
    #
    # So: a pause between every query, and a cap on how many one run
    # may build. The timer asks for a slice; the whole list still
    # refreshes, it just does not starve the site while it does.
    pause = max(0.0, float(sleep))
    # An entry that is still fresh is LEFT ALONE. This is what makes the
    # timer cheap and idempotent: each pass refreshes whatever has aged
    # past the threshold, so the whole list stays current without the
    # builder ever rebuilding all of it at once.
    ages = {} if full else stored_ages()
    min_age_s = min_age_minutes * 60
    for q in queries:
        for window in windows:
            since = since_for(window)
            for lim in limits:
                key = query_key(q, window, "", lim)
                age = ages.get(key)
                if age is not None and age < min_age_s:
                    skipped += 1
                    continue
                params = {"q": q, "limit": lim}
                if since:
                    params["since"] = since
                if max_entries and built >= max_entries:
                    log(f"stopping at the {max_entries}-entry cap (the rest waits for the next pass)")
                    break
                payload = api_get("/api/pins", params)
                if payload is None or not payload.get("pins"):
                    failed += 1
                    continue
                slimmed = slim(payload)
                try:
                    with connect() as conn:
                        conn.execute(
                        """
                        INSERT INTO search_preindex
                            (query_key, query, time_window, tag, limit_n, payload, pin_count, built_at, expires_at)
                        VALUES (%s, %s, %s, '', %s, %s::jsonb, %s, now(), now() + (%s || ' hours')::interval)
                        ON CONFLICT (query_key, time_window, tag, limit_n) DO UPDATE
                            SET query = EXCLUDED.query,
                                payload = EXCLUDED.payload,
                                pin_count = EXCLUDED.pin_count,
                                built_at = now(),
                                expires_at = EXCLUDED.expires_at
                        """,
                        (
                            key,
                            q,
                            window,
                            lim,
                            json.dumps(slimmed),
                            len(slimmed["pins"]),
                            str(MAX_AGE_HOURS),
                        ),
                        )
                    built += 1
                    if pause:
                        time.sleep(pause)
                except Exception as e:
                    log(f"store failed for {q!r} [{window}]: {e}")
                    failed += 1
    log(
        f"built {built} entries, skipped {skipped} (still fresh), "
        f"{failed} failures, {time.time() - t0:.1f}s"
    )
    return {"candidates": len(queries), "built": built, "skipped": skipped, "failed": failed}


def stats() -> dict:
    out: dict = {}
    try:
        with connect() as conn:
            rows = conn.execute(
                """
                SELECT count(*) AS entries,
                       count(DISTINCT query) AS queries,
                       max(built_at) AS newest,
                       min(built_at) AS oldest,
                       sum(pg_column_size(payload)) AS bytes
                FROM search_preindex
                """
            ).fetchall()
            out["preindex"] = dict(rows[0]) if rows else {}
            rows = conn.execute(
                """
                SELECT query, use_count, last_used_at FROM search_query_stats
                ORDER BY use_count DESC LIMIT 15
                """
            ).fetchall()
            out["top_queries"] = [dict(r) for r in rows]
    except Exception as e:
        out["error"] = str(e)
    return out


def verify() -> dict:
    """Is the store fresh? The oldest entry is the one that matters."""
    try:
        with connect() as conn:
            rows = conn.execute(
                """
                SELECT time_window AS window, count(*) AS entries, min(built_at) AS oldest, max(built_at) AS newest
                FROM search_preindex GROUP BY time_window ORDER BY time_window
                """
            ).fetchall()
    except Exception as e:
        return {"error": str(e)}
    ok = True
    for r in rows:
        age_h = (time.time() - r["oldest"].timestamp()) / 3600 if r["oldest"] else 999
        r["oldest_age_hours"] = round(age_h, 2)
        r["fresh"] = age_h <= MAX_AGE_HOURS
        ok = ok and r["fresh"]
    return {"windows": rows, "all_fresh": ok}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", action="store_true", help="build/refresh the pre-index")
    ap.add_argument("--stats", action="store_true", help="print store statistics")
    ap.add_argument("--verify", action="store_true", help="check that the store is fresh")
    ap.add_argument("--dry-run", action="store_true", help="list the candidates and stop")
    ap.add_argument("--limit", type=int, default=1000, help="how many candidate queries")
    ap.add_argument("--window", action="append", default=None, help="restrict to a window")
    ap.add_argument("--limits", default=None, help="comma-separated limits (default 1000,500)")
    ap.add_argument(
        "--min-age",
        type=int,
        default=30,
        help="minutes before an entry is refreshed again (default 30)",
    )
    ap.add_argument("--full", action="store_true", help="rebuild everything, ignoring the age")
    ap.add_argument(
        "--sleep",
        type=float,
        default=2.0,
        help="seconds to pause between entries (the default keeps the database free for readers)",
    )
    ap.add_argument(
        "--max",
        type=int,
        default=0,
        help="build at most this many entries in one pass (0 = no cap)",
    )
    args = ap.parse_args()

    if args.stats:
        print(json.dumps(stats(), indent=2, default=str))
        return 0
    if args.verify:
        print(json.dumps(verify(), indent=2, default=str))
        return 0
    if args.build or args.dry_run:
        limits = [int(x) for x in args.limits.split(",")] if args.limits else None
        build(
            args.limit,
            args.window,
            dry_run=args.dry_run,
            min_age_minutes=args.min_age,
            full=args.full,
            limits=limits,
            sleep=args.sleep,
            max_entries=args.max,
        )
        return 0
    ap.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
