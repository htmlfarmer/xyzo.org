"""Wildlife / biodiversity source registry — validation and import.

The registry lives in ``worker/data/wildlife_sources.json``. Every entry is a
CANDIDATE: nothing is written to ``news_sources`` until the feed has been
probed for real.

Why a probe is mandatory
------------------------
A homepage that answers 200 tells you nothing about the feed. Half the
conservation orgs in the world ship a WordPress site with the feed moved, a
Cloudflare interstitial in front of it, or a feed that parses but has been
empty for two years. Ingesting an unprobed feed produces a source that
looks healthy in the admin panel and never yields an article — the exact
failure mode of the inactive rows already sitting in ``news_sources``.

What the probe does, per candidate
----------------------------------
1. Tries every candidate feed URL listed in the registry.
2. If all of them fail, fetches the homepage and looks for
   ``<link rel="alternate" type="application/rss+xml">`` / ``atom+xml``.
3. Falls back to the common WordPress/feed conventions relative to the
   homepage (``/feed/``, ``/rss/``, ``/rss.xml``, ``/feed.xml``,
   ``?feed=rss2``, ``/atom.xml``, ``/index.xml``, ``/blog/feed/``).
4. Parses the body with ``feedparser`` and requires **at least one entry**
   — a feed that parses but is empty is EMPTY, not WORKING.
5. Consults ``robots.txt`` for the winning URL. A robots-disallowed feed is
   reported as BLOCKED and is never imported.

Politeness (AGENTS.md — Parallel Fetching Rules)
-----------------------------------------------
Different hosts are fetched in parallel; the SAME host is fetched strictly
sequentially with a per-host gap. ``worker.robots.RobotsCache`` supplies the
robots verdict and honours the declared ``Crawl-delay``.

Usage
-----
    python3 -m worker.wildlife_sources validate            # probe, write report
    python3 -m worker.wildlife_sources validate --limit 40  # probe a slice
    python3 -m worker.wildlife_sources import --apply       # write to DB
    python3 -m worker.wildlife_sources report              # show last report
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from .robots import RobotsCache, tier_for_url

REGISTRY_PATH = Path(__file__).parent / "data" / "wildlife_sources.json"
REPORT_PATH = Path(__file__).parent.parent / "logs" / "wildlife_sources_report.json"

USER_AGENT = "XyzoFetcher/0.1 (+https://xyzo.org/bot; contact@xyzo.org)"
POLITE_UA = "xyzo-events-bot/1.0 (+https://xyzo.org/bot) polite-fetch"

REQUEST_TIMEOUT = 12.0
SAME_HOST_GAP_S = 1.2
MAX_WORKERS = 10

# A candidate gets at most this many seconds of wall clock. Without it a
# single slow host burns 12 requests × 12 s and stalls the whole sweep.
CANDIDATE_DEADLINE_S = 40.0

# Common feed conventions tried when the registry's own candidates all fail
# and the homepage carries no <link rel="alternate">.
COMMON_FEED_PATHS = (
    "/feed/",
    "/rss/",
    "/rss.xml",
    "/feed.xml",
    "/?feed=rss2",
    "/atom.xml",
    "/index.xml",
)

_ALTERNATE_RE = re.compile(
    r"""<link[^>]+rel=["']?alternate["']?[^>]*>""",
    re.IGNORECASE,
)
_HREF_RE = re.compile(r"""href=["']([^"']+)["']""", re.IGNORECASE)
_TYPE_RE = re.compile(r"""type=["']([^"']+)["']""", re.IGNORECASE)

# Second-pass discovery: ANY href on the homepage that looks feed-ish.
# Plenty of publishers link their feed from a nav item or a footer link
# rather than a <link rel="alternate"> head tag.
_FEEDISH_RE = re.compile(
    r"""href=["']([^"']*(?:/rss|/feed|feed\.xml|rss\.xml|/rss|atom\.xml|/rdf|\.rss)[^"']*)["']""",
    re.IGNORECASE,
)
_XML_LINK_RE = re.compile(
    r"""<link[^>]+type=["']application/(?:rss|atom|rdf)\+xml["'][^>]*>""",
    re.IGNORECASE,
)


# ── registry ──────────────────────────────────────────────────────────────

def load_registry(path: Path | None = None) -> list[dict[str, Any]]:
    """Load the candidate registry."""
    p = path or REGISTRY_PATH
    data = json.loads(p.read_text())
    return data["sources"]


# ── probe primitives ──────────────────────────────────────────────────────

@dataclass
class Probe:
    """The result of probing one feed URL."""
    url: str
    ok: bool = False
    status: int | None = None
    entries: int = 0
    title: str | None = None
    error: str | None = None
    homepage: str | None = None
    discovered: bool = False          # found via homepage <link> or convention


@dataclass
class Result:
    """The result of probing one registry candidate."""
    source_id: str
    name: str
    ok: bool = False
    feed_url: str | None = None
    homepage_url: str | None = None
    feed_title: str | None = None
    entries: int = 0
    robots_allowed: bool | None = None
    robots_note: str = ""
    discovery: str = ""               # how the feed was found
    error: str | None = None
    tried: list[str] = field(default_factory=list)


def _user_agent_for(url: str) -> str:
    """Same UA the fetcher uses for this host — robots must be checked with
    the UA that will actually fetch (worker/fetch.py:user_agent_for)."""
    tier = tier_for_url(url)
    if tier in ("gov", "university"):
        return POLITE_UA
    return USER_AGENT


def _fetch(url: str, client: httpx.Client) -> tuple[int | None, bytes, str | None]:
    try:
        resp = client.get(url, headers={"User-Agent": _user_agent_for(url)})
        return resp.status_code, resp.content, None
    except httpx.HTTPError as exc:
        return None, b"", f"{type(exc).__name__}: {exc}"
    except Exception as exc:  # noqa: BLE001 - never let one host kill the run
        return None, b"", f"{type(exc).__name__}: {exc}"


def _parse_feed(content: bytes) -> tuple[int, str | None]:
    """Return (entry_count, feed_title)."""
    import feedparser

    parsed = feedparser.parse(content)
    if parsed.bozo and not parsed.entries:
        raise ValueError(f"parse error: {parsed.bozo_exception}")
    entries = parsed.entries or []
    title = parsed.feed.get("title") if isinstance(parsed.feed, dict) else None
    return len(entries), (str(title)[:200] if title else None)


def _discover_alternates(html: str, base: str) -> list[str]:
    """Pull feed URLs out of <link rel="alternate"> tags in a homepage."""
    found: list[str] = []
    for tag in _ALTERNATE_RE.findall(html):
        type_m = _TYPE_RE.search(tag)
        if type_m and type_m.group(1).lower() not in (
            "application/rss+xml",
            "application/atom+xml",
            "application/rdf+xml",
        ):
            continue
        href_m = _HREF_RE.search(tag)
        if not href_m:
            continue
        href = href_m.group(1).strip()
        if not href:
            continue
        if href.startswith("//"):
            href = "https:" + href
        found.append(urljoin(base, href))
    # de-dup, preserve order
    seen: set[str] = set()
    out: list[str] = []
    for u in found:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def probe_feed(url: str, client: httpx.Client) -> Probe:
    """Fetch and parse one feed URL."""
    probe = Probe(url=url)
    status, content, err = _fetch(url, client)
    probe.status = status
    if err:
        probe.error = err
        return probe
    if status is None or status >= 400:
        probe.error = f"HTTP {status}"
        return probe
    try:
        entries, title = _parse_feed(content)
    except Exception as exc:  # noqa: BLE001
        probe.error = str(exc)[:160]
        return probe
    probe.entries = entries
    probe.title = title
    probe.ok = entries > 0
    if not probe.ok:
        probe.error = "no entries"
    return probe


def _discover_feedish(html: str, base: str) -> list[str]:
    """Pull feed-ish hrefs out of a homepage body (nav links, footers)."""
    out: list[str] = []
    seen: set[str] = set()
    for pat in (_FEEDISH_RE,):
        for href in pat.findall(html):
            href = href.strip()
            if not href or href.startswith("#") or href.startswith("mailto:"):
                continue
            if href.startswith("//"):
                href = "https:" + href
            full = urljoin(base, href)
            if full in seen:
                continue
            seen.add(full)
            out.append(full)
    return out


def probe_candidate(
    src: dict[str, Any],
    client: httpx.Client,
    robots: RobotsCache,
    deep: bool = False,
) -> Result:
    """Probe one registry candidate, returning the first WORKING feed.

    ``deep`` widens the discovery pass: it scans every feed-ish href on the
    homepage, not just the ``<link rel="alternate">`` head tag, and it tries
    the site-specific paths the registry lists.
    """
    res = Result(source_id=src.get("id", ""), name=src.get("name", ""))
    homepage = src.get("homepage")
    res.homepage_url = homepage
    started = time.monotonic()
    deadline = CANDIDATE_DEADLINE_S * (2.0 if deep else 1.0)

    def expired() -> bool:
        return (time.monotonic() - started) > deadline

    def try_url(url: str, discovered: bool) -> bool:
        res.tried.append(url)
        p = probe_feed(url, client)
        if not p.ok:
            return False
        res.ok = True
        res.feed_url = url
        res.entries = p.entries
        res.feed_title = p.title
        res.discovery = discovered
        return True

    # 1) the registry's own candidates
    for url in src.get("feeds") or []:
        if try_url(url, "registry"):
            break
        if expired():
            break

    # 2) homepage <link rel="alternate">
    if not res.ok and homepage and not expired():
        status, content, _ = _fetch(homepage, client)
        if status is not None and status < 400 and content:
            html = content[:400_000].decode("utf-8", "ignore")
            for alt in _discover_alternates(html, homepage)[:5]:
                if alt in res.tried:
                    continue
                if try_url(alt, "homepage-link"):
                    break
                if expired():
                    break

            # 2b) deep pass — any feed-ish link anywhere in the page
            if not res.ok and deep and not expired():
                for alt in _discover_feedish(html, homepage)[:8]:
                    if alt in res.tried:
                        continue
                    if try_url(alt, "homepage-scan"):
                        break
                    if expired():
                        break

    # 3) common conventions relative to the homepage
    if not res.ok and homepage and not expired():
        base = homepage if homepage.endswith("/") else homepage + "/"
        for path in COMMON_FEED_PATHS:
            url = urljoin(base, path.lstrip("/")) if not path.startswith("/?") else urljoin(base, path[1:])
            if url in res.tried:
                continue
            if try_url(url, "convention"):
                break
            if expired():
                break

    if not res.ok:
        res.error = "no working feed found"
        return res

    # robots.txt — the decisive check
    verdict = robots.is_allowed(res.feed_url)
    res.robots_allowed = verdict.allowed
    res.robots_note = verdict.note or ""
    if not verdict.allowed:
        res.ok = False
        res.error = f"robots disallowed ({verdict.note or verdict.disallowed_path})"
    return res


# ── validation run ────────────────────────────────────────────────────────

def _host_of(url: str) -> str:
    return (urlparse(url).hostname or "").lower()


def validate(
    sources: list[dict[str, Any]],
    limit: int | None = None,
    workers: int = MAX_WORKERS,
    deep: bool = False,
    only_ids: set[str] | None = None,
) -> list[Result]:
    """Probe every candidate. Same host → sequential; different hosts → parallel."""
    if only_ids is not None:
        sources = [s for s in sources if s.get("id") in only_ids]
    else:
        sources = [s for s in sources if not s.get("skip")]
    if limit:
        sources = sources[:limit]

    robots = RobotsCache()
    results: list[Result] = []
    lock = threading.Lock()

    # Group by the homepage host so a host is never hit concurrently.
    groups: dict[str, list[dict[str, Any]]] = {}
    for s in sources:
        groups.setdefault(_host_of(s.get("homepage") or ""), []).append(s)

    def run_group(group: list[dict[str, Any]]) -> list[Result]:
        out: list[Result] = []
        with httpx.Client(
            timeout=REQUEST_TIMEOUT,
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT},
        ) as client:
            last = 0.0
            for s in group:
                gap = time.monotonic() - last
                if gap < SAME_HOST_GAP_S:
                    time.sleep(SAME_HOST_GAP_S - gap)
                try:
                    r = probe_candidate(s, client, robots, deep=deep)
                except Exception as exc:  # noqa: BLE001
                    r = Result(source_id=s.get("id", ""), name=s.get("name", ""))
                    r.error = f"probe crashed: {type(exc).__name__}: {exc}"
                last = time.monotonic()
                out.append(r)
                with lock:
                    done[0] += 1
                    if done[0] % 10 == 0 or r.ok:
                        print(
                            f"[{done[0]:>3}/{total}] {'OK  ' if r.ok else 'FAIL'} "
                            f"{r.name[:50]}",
                            flush=True,
                        )
        return out

    total = len(sources)
    done = [0]
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for group_out in pool.map(run_group, groups.values()):
            with lock:
                results.extend(group_out)

    order = {s.get("id"): i for i, s in enumerate(sources)}
    results.sort(key=lambda r: order.get(r.source_id, 10**9))
    return results


def write_report(
    results: list[Result],
    sources: list[dict[str, Any]],
    merge: bool = False,
) -> None:
    """Write the validation report. ``merge`` keeps the previous pass's
    WORKING results — a deep retry must not erase what the first pass found."""
    by_id = {s.get("id"): s for s in sources}
    merged: dict[str, dict[str, Any]] = {}
    if merge and REPORT_PATH.exists():
        try:
            prev = json.loads(REPORT_PATH.read_text())
            for row in prev.get("results", []):
                if row.get("ok"):
                    merged[row["id"]] = row
        except (OSError, ValueError):
            pass

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "total": len(results),
        "working": 0,
        "robots_blocked": 0,
        "failed": 0,
        "results": [],
    }
    rows = []
    for r in results:
        s = by_id.get(r.source_id) or {}
        row = {
            "id": r.source_id,
            "name": r.name,
            "ok": r.ok,
            "feed_url": r.feed_url,
            "homepage_url": r.homepage_url,
            "feed_title": r.feed_title,
            "entries": r.entries,
            "robots_allowed": r.robots_allowed,
            "discovery": r.discovery,
            "error": r.error,
            "tried": r.tried[:8],
            "priority": s.get("priority"),
            "country": s.get("country"),
            "region": s.get("region"),
            "language": s.get("language"),
            "scope": s.get("scope"),
            "topics": s.get("topics"),
            "focus": s.get("focus"),
            "subfocus": s.get("subfocus"),
            "paywall": s.get("paywall", False),
            "feed_scope": s.get("feed_scope", "wildlife"),
            "skip": bool(s.get("skip")),
            "skip_reason": s.get("skip_reason"),
        }
        rows.append(row)
        if r.ok:
            merged[r.source_id] = row

    # The registry is the source of truth for the row order.
    order = [s.get("id") for s in sources]
    final: list[dict[str, Any]] = []
    seen: set[str] = set()
    for rid in order:
        if rid in merged:
            final.append(merged[rid])
            seen.add(rid)
    for row in rows:
        if row["id"] not in seen:
            final.append(row)
            seen.add(row["id"])

    payload["results"] = final
    payload["total"] = len(final)
    payload["working"] = sum(1 for r in final if r.get("ok"))
    payload["robots_blocked"] = sum(
        1 for r in final if not r.get("ok") and r.get("robots_allowed") is False
    )
    payload["failed"] = sum(
        1 for r in final if not r.get("ok") and r.get("robots_allowed") is None
    )
    REPORT_PATH.write_text(json.dumps(payload, indent=2))


def load_report() -> dict[str, Any]:
    if not REPORT_PATH.exists():
        raise SystemExit(
            f"no report at {REPORT_PATH} — run `python3 -m worker.wildlife_sources validate` first"
        )
    return json.loads(REPORT_PATH.read_text())


# ── import ────────────────────────────────────────────────────────────────

SCOPE_TO_LOCALITY = {
    "national": "national",
    "regional": "regional",
    "international": "international",
}

# Feeds that are technically valid but are the WRONG thing to ingest: a
# comment stream or a podcast enclosure feed. Both parse cleanly and both
# flood the pipeline with noise ("Comments are closed", episode metadata).
BAD_FEED_URL_HINTS = (
    "/comments/feed",
    "/comment/feed",
    "/feed/podcast",
    "/podcast/feed",
    "/feed/audio",
    "/comments.xml",
)
BAD_TITLE_HINTS = (
    "comments are closed",
    "comment feed",
    "comments on",
    "podcast",
    "comments for",
)


def feed_is_usable(row: dict[str, Any]) -> tuple[bool, str]:
    """Reject comment/podcast feeds — they parse but carry no news."""
    url = (row.get("feed_url") or "").lower()
    for hint in BAD_FEED_URL_HINTS:
        if hint in url:
            return False, f"comment/podcast feed ({hint})"
    title = (row.get("feed_title") or "").lower()
    for hint in BAD_TITLE_HINTS:
        if hint in title:
            return False, f"comment/podcast feed (title '{hint}')"
    return True, ""


def dedupe_rows(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """One row per feed_url — keep the highest-priority entry.

    A regional BirdLife feed URL often resolves to the global feed, so eight
    registry entries can land on one URL. ``news_sources.feed_url`` is
    UNIQUE, so the extras would silently vanish; dropping them here keeps
    the report honest.
    """
    by_url: dict[str, dict[str, Any]] = {}
    dropped: list[dict[str, Any]] = []
    for row in sorted(
        rows,
        key=lambda r: ((r.get("priority") or 6), -(r.get("entries") or 0), r.get("name") or ""),
    ):
        url = row["feed_url"]
        if url in by_url:
            dropped.append(row)
            continue
        by_url[url] = row
    return list(by_url.values()), dropped


def derive_skip_flags(
    sources: list[dict[str, Any]], report: dict[str, Any]
) -> dict[str, str]:
    """Decide which registry entries are dead, from the probe evidence.

    The registry keeps every candidate — a source with no feed today may have
    one tomorrow, and the record of WHY it failed is worth more than a
    silently deleted row. The skip flag is derived, never hand-maintained, so
    the registry can never claim a source works when it does not.

    Two rules apply:
      * an entry with no working feed is skipped with the probe's reason;
      * an entry that is an ALIAS of another publisher (``alias_of``) is
        skipped — ``snowleopard.org`` is the Snow Leopard Trust, and
        ``hakaimagazine.com/feed/`` is the same documents as
        ``www.hakaimagazine.com/feed/``. Two rows for one publisher means
        the same story lands on the map twice.
    """
    by_id = {s.get("id"): s for s in sources}
    reasons: dict[str, str] = {}
    for row in report.get("results", []):
        rid = row.get("id")
        s = by_id.get(rid) or {}
        if s.get("data_portal"):
            reasons[rid] = s.get("note") or "data portal, not a news feed"
            continue
        if row.get("ok"):
            continue
        if row.get("robots_allowed") is False:
            reasons[rid] = f"robots.txt disallows the feed ({row.get('error')})"
        else:
            reasons[rid] = "no working RSS feed found at the probed URLs"
    # aliases: a curated field, so the reason is explicit
    for s in sources:
        alias = s.get("alias_of")
        if alias:
            reasons[s["id"]] = f"same publisher as '{alias}' — one row per publisher"
    return reasons


def write_skip_flags(
    sources: list[dict[str, Any]], report: dict[str, Any]
) -> int:
    """Write the derived skip flags back into the registry file."""
    reasons = derive_skip_flags(sources, report)
    path = REGISTRY_PATH
    doc = json.loads(path.read_text())
    n = 0
    for s in doc["sources"]:
        rid = s.get("id")
        if rid in reasons:
            s["skip"] = True
            s["skip_reason"] = reasons[rid]
            n += 1
        else:
            s.pop("skip", None)
            s.pop("skip_reason", None)
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    return n


def import_sources(
    sources: list[dict[str, Any]],
    report: dict[str, Any],
    apply: bool = False,
    max_priority: int = 6,
) -> dict[str, Any]:
    """Write the working sources into news_sources (and worker/feeds.json).

    ``news_sources`` is the table the fetcher reads (worker/fetch.py CLAIM_SQL);
    ``worker/feeds.json`` is the curation list the audit tooling reads. Both
    are written so the two never drift for these sources.
    """
    by_id = {s.get("id"): s for s in sources}
    working = [
        r for r in report["results"]
        if r.get("ok")
        and not (by_id.get(r["id"], {}).get("skip"))
        and not (by_id.get(r["id"], {}).get("alias_of"))
        and (by_id.get(r["id"], {}).get("priority") or 6) <= max_priority
    ]

    # 1) reject comment/podcast feeds
    usable: list[dict[str, Any]] = []
    rejected: list[tuple[str, str]] = []
    for r in working:
        ok, why = feed_is_usable(r)
        if ok:
            usable.append(r)
        else:
            rejected.append((r["name"], why))

    # 2) one row per feed_url
    usable, dropped = dedupe_rows(usable)

    if not apply:
        print(f"[dry-run] would import {len(usable)} sources")
        print(f"          skipped {len(dropped)} duplicate feed URLs")
        print(f"          skipped {len(rejected)} comment/podcast feeds")
        for r in usable[:40]:
            print(f"  {r['name'][:42]:44} {r['feed_url']}")
        if len(usable) > 40:
            print(f"  … and {len(usable) - 40} more")
        for n, w in rejected:
            print(f"  REJECT {n[:40]:42} {w}")
        return {"imported": 0, "dry_run": True}

    from .db import connect

    rows = []
    for r in usable:
        s = by_id.get(r["id"]) or {}
        # The country is the publisher's EDITORIAL BASE, and it drives the
        # single-city source fallback. A publisher whose output covers a
        # whole region or the whole world has no single country — giving it
        # one would pin every one of its stories to that country's capital
        # (the Bamako pileup). Those rows carry country=NULL and the
        # coverage role in `locality`; the article is then placed from its
        # own text or left unlocated, which is the honest outcome.
        scope = s.get("scope") or "international"
        rows.append(
            {
                "name": r["name"],
                "feed_url": r["feed_url"],
                "homepage_url": s.get("homepage") or r.get("homepage_url"),
                "country": s.get("country") if scope == "national" else None,
                "language": s.get("language"),
                "region": s.get("region") or "global",
                "source_type": "rss",
                "locality": SCOPE_TO_LOCALITY.get(scope, "international"),
                "topics": s.get("topics") or ["wildlife"],
                "topic": s.get("topic") or "wildlife",
                "science_focus": s.get("focus"),
                "science_subfocus": s.get("subfocus"),
                "paywall": bool(s.get("paywall", False)),
                "free_access": not bool(s.get("paywall", False)),
                "license": "open",
                "active": True,
                "base_domain": _host_of(r["feed_url"]),
            }
        )

    inserted = updated = 0
    existing_skipped: list[str] = []
    with connect() as conn, conn.cursor() as cur:
        for row in rows:
            cur.execute("SELECT id, active FROM news_sources WHERE feed_url = %s", (row["feed_url"],))
            pre = cur.fetchone()
            if pre:
                # Already ingested. Do NOT create a second row (feed_url is
                # UNIQUE) and do NOT re-point a live general-news source at
                # a wildlife label it does not deserve.
                existing_skipped.append(row["name"])
                continue
            cur.execute(
                """
                INSERT INTO news_sources (
                    name, feed_url, homepage_url, country, language, region,
                    source_type, locality, topics, topic, science_focus,
                    science_subfocus, paywall, free_access, license, active,
                    base_domain, robots_status
                )
                VALUES (
                    %(name)s, %(feed_url)s, %(homepage_url)s, %(country)s,
                    %(language)s, %(region)s, %(source_type)s, %(locality)s,
                    %(topics)s, %(topic)s, %(science_focus)s,
                    %(science_subfocus)s, %(paywall)s, %(free_access)s,
                    %(license)s, %(active)s, %(base_domain)s, 'allowed'
                )
                RETURNING id
                """,
                row,
            )
            inserted += 1

        # Re-enable the dormant wildlife sources whose feed now probes clean
        # (Smithsonian, National Geographic, Yale Environment 360 were left
        # inactive and never produced an article). Only rows whose publisher
        # name still matches are touched — a stale row for a DIFFERENT feed
        # on the same domain must not be repointed at an unrelated feed.
        revived = 0
        for r in usable:
            s = by_id.get(r["id"]) or {}
            cur.execute(
                """
                UPDATE news_sources
                   SET active = TRUE,
                       topic = COALESCE(NULLIF(topic, ''), %s),
                       topics = COALESCE(topics, %s),
                       locality = COALESCE(locality, %s),
                       homepage_url = COALESCE(homepage_url, %s),
                       updated_at = now()
                 WHERE feed_url = %s AND active = FALSE AND deleted_at IS NULL
                RETURNING id
                """,
                (
                    s.get("topic") or "wildlife",
                    s.get("topics") or ["wildlife"],
                    SCOPE_TO_LOCALITY.get(s.get("scope") or "", "international"),
                    s.get("homepage"),
                    r["feed_url"],
                ),
            )
            if cur.fetchone():
                revived += 1

    # ── feeds.json mirror ──
    # The DB is the source of truth for the wildlife set, so the mirror is
    # written FROM it. A one-way append would leave the old country values
    # in feeds.json, and `worker.run --seed-feeds` upserts country from
    # there — which would put the pileup straight back.
    feeds_path = Path(__file__).parent / "feeds.json"
    feeds_doc = json.loads(feeds_path.read_text())
    feeds = feeds_doc["feeds"]
    by_url = {f.get("feed_url"): f for f in feeds}

    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT feed_url, name, homepage_url, country, language, region, source_type
              FROM news_sources
             WHERE deleted_at IS NULL AND topics IS NOT NULL
            """
        )
        # The pool's row factory is dict_row — unpack by key, never by
        # position (iterating a dict yields its KEYS, which silently
        # wrote an entry called "feed_url" into feeds.json).
        mirror_rows = [dict(r) for r in cur.fetchall()]

    added_json = updated_json = 0
    for row in mirror_rows:
        feed_url = row["feed_url"]
        entry = {
            "name": row["name"],
            "feed_url": feed_url,
            "homepage_url": row["homepage_url"],
            "country": row["country"],
            "language": row["language"],
            "region": row["region"],
            "source_type": row["source_type"] or "rss",
            "enabled": True,
        }
        existing = by_url.get(feed_url)
        if existing is None:
            feeds.append(entry)
            by_url[feed_url] = entry
            added_json += 1
        elif existing != entry:
            existing.update(entry)
            updated_json += 1
    feeds_doc["feeds"] = feeds
    feeds_path.write_text(json.dumps(feeds_doc, indent=2, ensure_ascii=False) + "\n")

    return {
        "inserted": inserted,
        "already_in_db": len(existing_skipped),
        "revived_inactive": revived,
        "duplicate_urls_dropped": len(dropped),
        "comment_podcast_rejected": len(rejected),
        "feeds_json_added": added_json,
        "feeds_json_updated": updated_json,
        "dry_run": False,
    }


# ── CLI ───────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_val = sub.add_parser("validate", help="probe every candidate feed")
    p_val.add_argument("--limit", type=int, default=None)
    p_val.add_argument("--workers", type=int, default=MAX_WORKERS)
    p_val.add_argument(
        "--retry-failed",
        action="store_true",
        help="re-probe only the candidates that failed, with the deep "
        "homepage scan; merges into the existing report",
    )
    p_val.add_argument(
        "--merge",
        action="store_true",
        help="keep previously-WORKING results in the report",
    )

    p_imp = sub.add_parser("import", help="write working sources into the DB")
    p_imp.add_argument("--apply", action="store_true")
    p_imp.add_argument("--max-priority", type=int, default=6)
    p_imp.add_argument(
        "--write-skips",
        action="store_true",
        help="write the derived skip flags back into the registry file",
    )

    sub.add_parser("report", help="print the last validation report")

    args = ap.parse_args(argv)
    sources = load_registry()

    if args.cmd == "validate":
        only_ids = None
        deep = False
        if args.retry_failed:
            prev = load_report()
            only_ids = {
                r["id"] for r in prev.get("results", []) if not r.get("ok")
            }
            deep = True
            print(f"retrying {len(only_ids)} failed candidates (deep scan)…")
        else:
            print(f"probing {len(sources) if not args.limit else args.limit} candidates…")
        results = validate(
            sources,
            limit=args.limit,
            workers=args.workers,
            deep=deep,
            only_ids=only_ids,
        )
        write_report(results, sources, merge=args.merge or args.retry_failed)
        ok = [r for r in results if r.ok]
        blocked = [r for r in results if not r.ok and r.robots_allowed is False]
        failed = [r for r in results if not r.ok and r.robots_allowed is None]
        print(f"\nthis pass: {len(ok)} WORKING | {len(blocked)} robots-blocked | {len(failed)} failed")
        rep = json.loads(REPORT_PATH.read_text())
        print(f"report total: {rep['working']}/{rep['total']} working")
        print(f"report: {REPORT_PATH}")
        for r in results:
            if r.ok:
                print(f"  OK    {r.name[:44]:46} {r.feed_url}")
            elif r.robots_allowed is False:
                print(f"  BLOCK {r.name[:44]:46} {r.error}")
        return 0

    if args.cmd == "import":
        report = load_report()
        if args.write_skips:
            n = write_skip_flags(sources, report)
            print(f"wrote {n} skip flags into {REGISTRY_PATH}")
            sources = load_registry()
        stats = import_sources(
            sources, report, apply=args.apply, max_priority=args.max_priority
        )
        print(json.dumps(stats, indent=2))
        return 0

    if args.cmd == "report":
        report = load_report()
        print(
            f"{report['working']}/{report['total']} working "
            f"({report['robots_blocked']} robots-blocked, {report['failed']} failed)"
        )
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
