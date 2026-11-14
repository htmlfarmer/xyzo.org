"""Geocoder — turns `news_articles.location_text` into lat/lng via Nominatim.

Public Nominatim instance requires 1 request/sec max. We sleep between calls
and send a User-Agent per the ToS. Self-hosted Nominatim can replace the URL
via NEWSIUM_NOMINATIM_URL.

Geocoded results are stored in `news_locations`, deduped by
(place_name_normalized, ROUND(lat,3), ROUND(lng,3)) so the same place is
resolved once across many articles.

Two execution paths are supported:

1.  Legacy synchronous loop (preserved) — ``run()``. This is the one called
    by ``worker/run.py`` and ``worker/fast_update.py`` today; it stays as
    the back-compat contract.

2.  Parallel batch geocoder (added Audit 3+4) — ``Geocoder``. Fans a list
    of articles out to a ThreadPoolExecutor, honours the global Nominatim
    rate limit via a shared lock + last-call timestamp, prefills the
    ``news_locations`` cache once per batch, and writes results back to
    the DB from each worker thread.

Why a shared throttle when we have multiple threads?
   Public Nominatim is 1 req/sec per the ToS. The shared throttle keeps us
   inside that budget. The benefit of the thread pool is overlapping the
   (cheap) DB upsert / cache lookup / next-batch Nominatim fetch with the
   (slow) Nominatim HTTP RTT in flight on the previous article. Throughput
   is limited by Nominatim, NOT by parallelism, so don't expect speedup
   against the public host. Self-hosted Nominatim is the way to break
   free of that ceiling — drop ``NEWSIUM_GEOCODE_INTERVAL`` to ~0.05
   and bump ``max_workers``.

Public surfaces (do NOT change without updating callers in run.py /
fast_update.py / re_evaluate.py):

    run(limit, progress) -> dict           # legacy, sequential
    geocode_one(client, location_text)     # legacy helper
    upsert_location(loc) -> int            # row identity after geocode
    COUNTRY_CAPITALS, _normalize_place     # exported for fast_suggest / re_evaluate
    MAX_PER_CYCLE, MIN_INTERVAL_S          # tunables
"""
from __future__ import annotations

import logging
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Iterable

import httpx

from .db import connect
from .progress import ProgressWriter
from .config import geocode

log = logging.getLogger("newsium.geocode")

NOMINATIM_URL = geocode.NOMINATIM_URL
USER_AGENT = geocode.USER_AGENT
TIMEOUT_S = geocode.TIMEOUT_S
MIN_INTERVAL_S = geocode.MIN_INTERVAL_S
MAX_PER_CYCLE = geocode.MAX_PER_CYCLE
MAX_WORKERS = geocode.MAX_WORKERS
HTTPX_MAX_CONNECTIONS = geocode.HTTPX_MAX_CONNECTIONS
HTTPX_MAX_KEEPALIVE = geocode.HTTPX_MAX_KEEPALIVE

_HTTPX_LIMITS = httpx.Limits(
    max_connections=HTTPX_MAX_CONNECTIONS,
    max_keepalive_connections=HTTPX_MAX_KEEPALIVE,
)


def _normalize_place(s: str) -> str:
    """Lowercase, collapse whitespace, strip trailing punctuation."""
    s = re.sub(r"\s+", " ", s or "").strip().lower()
    s = s.rstrip(".,;:")
    return s


def _precision_from_class(cls: str, type_: str) -> str:
    """Map Nominatim class/type to our precision enum."""
    if type_ in {"house", "building", "amenity", "shop", "tourism", "historic"}:
        return "exact"
    if cls in {"place"} and type_ in {"city", "town", "village", "hamlet", "suburb", "quarter", "neighbourhood"}:
        return "city"
    if cls in {"place"} and type_ in {"state", "region", "province", "county", "district"}:
        return "region"
    if cls in {"place"} and type_ in {"country"}:
        return "country"
    return "city"


COUNTRY_CAPITALS = {
    # North America
    "united states": (38.8951, -77.0364, "US"),
    "us": (38.8951, -77.0364, "US"),
    "usa": (38.8951, -77.0364, "US"),
    "america": (38.8951, -77.0364, "US"),
    "canada": (45.4215, -75.6972, "CA"),
    "mexico": (19.4326, -99.1332, "MX"),

    # Europe
    "united kingdom": (51.5074, -0.1278, "GB"),
    "uk": (51.5074, -0.1278, "GB"),
    "u.k": (51.5074, -0.1278, "GB"),
    "u.k.": (51.5074, -0.1278, "GB"),
    "britain": (51.5074, -0.1278, "GB"),
    "england": (51.5074, -0.1278, "GB"),
    "france": (48.8566, 2.3522, "FR"),
    "germany": (52.5200, 13.4050, "DE"),
    "russia": (55.7558, 37.6173, "RU"),
    "ukraine": (50.4501, 30.5234, "UA"),
    "italy": (41.9028, 12.4964, "IT"),
    "spain": (40.4168, -3.7038, "ES"),
    "poland": (52.2297, 21.0122, "PL"),
    "netherlands": (52.3676, 4.9041, "NL"),
    "belgium": (50.8503, 4.3517, "BE"),
    "switzerland": (46.9480, 7.4474, "CH"),
    "austria": (48.2082, 16.3738, "AT"),
    "greece": (37.9838, 23.7275, "GR"),
    "ireland": (53.3498, -6.2603, "IE"),
    "sweden": (59.3293, 18.0686, "SE"),
    "norway": (59.9139, 10.7521, "NO"),
    "finland": (60.1699, 24.9384, "FI"),
    "denmark": (55.6761, 12.5683, "DK"),
    "portugal": (38.7223, -9.1393, "PT"),
    "hungary": (47.4979, 19.0402, "HU"),
    "czech republic": (50.0755, 14.4378, "CZ"),
    "czechia": (50.0755, 14.4378, "CZ"),
    "romania": (44.4323, 26.1063, "RO"),
    "belarus": (53.9006, 27.5590, "BY"),
    "turkey": (39.9334, 32.8597, "TR"),
    "türkiye": (39.9334, 32.8597, "TR"),

    # Asia & Middle East
    "china": (39.9042, 116.4074, "CN"),
    "japan": (35.6762, 139.6503, "JP"),
    "india": (28.6139, 77.2090, "IN"),
    "south korea": (37.5665, 126.9780, "KR"),
    "korea": (37.5665, 126.9780, "KR"),
    "north korea": (39.0392, 125.7625, "KP"),
    "indonesia": (-6.2088, 106.8456, "ID"),
    "pakistan": (33.6844, 73.0479, "PK"),
    "vietnam": (21.0285, 105.8542, "VN"),
    "thailand": (13.7563, 100.5018, "TH"),
    "philippines": (14.5995, 120.9842, "PH"),
    "malaysia": (3.1390, 101.6869, "MY"),
    "singapore": (1.3521, 103.8198, "SG"),
    "taiwan": (25.0330, 121.5654, "TW"),
    "israel": (31.7683, 35.2137, "IL"),
    "gaza": (31.5017, 34.4668, "PS"),
    "palestine": (31.7683, 35.2137, "PS"),
    "iran": (35.6892, 51.3890, "IR"),
    "saudi arabia": (24.7136, 46.6753, "SA"),
    "united arab emirates": (24.4539, 54.3773, "AE"),
    "uae": (24.4539, 54.3773, "AE"),
    "dubai": (25.2048, 55.2708, "AE"),
    "syria": (33.5138, 36.2929, "SY"),
    "iraq": (33.3152, 44.3661, "IQ"),
    "lebanon": (33.8938, 35.5018, "LB"),
    "yemen": (15.3694, 44.1910, "YE"),
    "jordan": (31.9454, 35.9284, "JO"),
    "afghanistan": (34.5553, 69.2075, "AF"),
    "bangladesh": (23.8103, 90.4125, "BD"),

    # Latin America
    "brazil": (-15.7975, -47.8919, "BR"),
    "argentina": (-34.6037, -58.3816, "AR"),
    "colombia": (4.7110, -74.0721, "CO"),
    "venezuela": (10.4806, -66.9036, "VE"),
    "peru": (-12.0464, -77.0428, "PE"),
    "chile": (-33.4489, -70.6693, "CL"),
    "cuba": (23.1136, -82.3666, "CU"),
    "haiti": (18.5944, -72.3074, "HT"),

    # Africa
    "egypt": (30.0444, 31.2357, "EG"),
    "nigeria": (9.0765, 7.3986, "NG"),
    "south africa": (-25.7479, 28.2293, "ZA"),
    "kenya": (-1.2921, 36.8219, "KE"),
    "ethiopia": (9.0300, 38.7400, "ET"),
    "congo": (-4.4419, 15.2663, "CD"),
    "dr congo": (-4.4419, 15.2663, "CD"),
    "drc": (-4.4419, 15.2663, "CD"),
    "central african republic": (4.3947, 18.5582, "CF"),
    "liberia": (6.3156, -10.8074, "LR"),
    "somalia": (2.0469, 45.3182, "SO"),
    "sudan": (15.5007, 32.5599, "SD"),
    "libya": (32.8872, 13.1913, "LY"),
    "algeria": (36.7538, 3.0588, "DZ"),
    "morocco": (34.0209, -6.8416, "MA"),

    # Oceania
    "australia": (-35.2809, 149.1300, "AU"),
    "new zealand": (-41.2865, 174.7762, "NZ"),
}

CITY_ALIASES = {
    "delhi": "New Delhi",
    "nueva delhi": "New Delhi",
    "nova deli": "New Delhi",
    "nuova delhi": "New Delhi",
}


# ──────────────────────────────────────────────────────────────────────────────
# Legacy sync helpers (DO NOT BREAK — callers in re_evaluate.py / fast_suggest.py
# import these directly)
# ──────────────────────────────────────────────────────────────────────────────


# ──────────────────────────────────────────────────────────────────────────────
# Transient vs decisive geocode failures (FIX_NOTES 1.5)
#
# A 429/5xx/timeout from Nominatim is NOT evidence that a place doesn't
# exist. Before this, every transient failure marked the article
# status='unlocated' — a terminal state nothing ever resets — parking
# 76k articles (many perfectly geocodable) out of the pipeline forever.
# Transient failures now raise; callers retry next cycle instead.
# ──────────────────────────────────────────────────────────────────────────────


class TransientGeocodeError(RuntimeError):
    """Nominatim was rate-limiting/down/timeout — retry, do not give up."""


def _ambiguous_country_hint(location_text: str, country_hint: str | None) -> str | None:
    """Return an ISO alpha-2 to bias Nominatim with, ONLY for the bare
    ambiguous names the watchlist already decided a source-country prior
    is correct for (e.g. "Virginia" from a US source). Comma-qualified
    strings ("Virginia, USA") need no bias — the query itself disambiguates."""
    if not country_hint or "," in location_text:
        return None
    try:
        from .place_disambiguation import AMBIGUOUS_CITY_COUNTRIES
    except Exception:
        return None
    bare = _normalize_place(location_text)
    allowed = AMBIGUOUS_CITY_COUNTRIES.get(bare)
    if not allowed:
        return None
    cc = (country_hint or "").strip().upper()
    return cc.lower() if cc in allowed else None


def geocode_one(client: httpx.Client, location_text: str,
                country_hint: str | None = None) -> dict | None:
    """Turn a location string into coordinates. The detective of the pipeline.

    Given "Paris, France" → returns {lat: 48.8566, lng: 2.3522, ...}
    Given "Mars" → returns None (we haven't colonized it yet)
    Given "40.7128, -74.0060" → returns New York City coordinates

    This function is the bridge between "what the article says" and
    "where on the map it should appear." It's surprisingly hard because
    location names are ambiguous, misspelled, and sometimes just wrong.

    Caller handles rate limiting (1 req/sec for public Nominatim).
    """
    norm = _normalize_place(location_text)
    if norm in CITY_ALIASES:
        location_text = CITY_ALIASES[norm]
        norm = _normalize_place(location_text)
    if norm in COUNTRY_CAPITALS:
        lat, lng, cc = COUNTRY_CAPITALS[norm]
        return {
            "place_name": location_text,
            "place_name_normalized": norm,
            "country": cc,
            "lat": lat,
            "lng": lng,
            "precision": "country",
            "confidence": 1.0,
            "osm_id": None,
            "osm_type": None,
        }

    params = {
        "q": location_text,
        "format": "json",
        "limit": 1,
        "addressdetails": 1,
    }
    cc_hint = _ambiguous_country_hint(location_text, country_hint)
    if cc_hint:
        params["countrycodes"] = cc_hint
    headers = {"User-Agent": USER_AGENT}
    try:
        resp = client.get(NOMINATIM_URL, params=params, headers=headers, timeout=TIMEOUT_S)
    except httpx.HTTPError as exc:
        raise TransientGeocodeError(f"nominatim transport error: {exc}") from exc
    if resp.status_code == 429:
        log.warning("Nominatim HTTP 429 (rate limited) for %r — sleeping 5s", location_text)
        time.sleep(5.0)
        raise TransientGeocodeError("nominatim 429")
    if resp.status_code != 200:
        log.warning("Nominatim HTTP %s for %r", resp.status_code, location_text)
        raise TransientGeocodeError(f"nominatim HTTP {resp.status_code}")
    rows = resp.json()
    if not rows:
        return None
    top = rows[0]
    try:
        lat = float(top["lat"])
        lng = float(top["lon"])
    except (KeyError, ValueError, TypeError):
        return None
    addr = top.get("address") or {}
    country = addr.get("country")
    precision = _precision_from_class(top.get("class", ""), top.get("type", ""))

    # If Nominatim returned a country-level location, redirect lat/lng to capital city if available
    if precision == "country" or top.get("type") == "country":
        country_norm = (country or location_text).lower().strip()
        if country_norm in COUNTRY_CAPITALS:
            lat, lng, _ = COUNTRY_CAPITALS[country_norm]

    return {
        "place_name": location_text,
        "place_name_normalized": norm,
        "country": country,
        "lat": lat,
        "lng": lng,
        "precision": precision,
        "confidence": 1.0,
        "osm_id": int(top["osm_id"]) if top.get("osm_id") and str(top["osm_id"]).isdigit() else None,
        "osm_type": top.get("osm_type"),
    }


def find_location_by_coords(lat: float, lng: float) -> int | None:
    """Find a news_locations id by exact lat/lng match. Returns None if not found."""
    if lat is None or lng is None or lat == 0 or lng == 0:
        return None
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM news_locations WHERE lat = %s AND lng = %s LIMIT 1",
            (lat, lng),
        )
        row = cur.fetchone()
        return row["id"] if row else None


def upsert_location(loc: dict) -> int:
    # FIX (2026-09-26, FIX_NOTES 1.3): the `with connect()...` line was
    # deleted by commit ca20404 (Sep 15), leaving `cur` undefined — every
    # call raised NameError, so NEW place names could never be bound
    # (259 articles in a re-geocode loop, "Re-evaluate this pin" dead).
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO news_locations (
                place_name, place_name_normalized, country, lat, lng,
                precision, confidence, osm_id, osm_type, geom
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s,
                    ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography)
            ON CONFLICT (place_name_normalized, ROUND(lat::numeric, 3), ROUND(lng::numeric, 3))
            DO UPDATE SET place_name = EXCLUDED.place_name
            RETURNING id
            """,
            (
                loc["place_name"], loc["place_name_normalized"], loc["country"],
                loc["lat"], loc["lng"], loc["precision"], loc["confidence"],
                loc["osm_id"], loc["osm_type"], loc["lng"], loc["lat"],
            ),
        )
        return cur.fetchone()["id"]


def _fetch_needing_geocode(limit: int) -> list[dict]:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT a.id, a.location_text, a.extracted_lat, a.extracted_lng, "
            "       s.country AS source_country "
            "FROM news_articles a "
            "LEFT JOIN news_sources s ON s.id = a.source_id "
            "WHERE a.status = 'extracted' AND a.location_id IS NULL "
            "  AND a.location_text IS NOT NULL AND a.location_text <> '' "
            "  AND (a.geocode_attempts IS NULL OR a.geocode_attempts < 5) "
            "ORDER BY a.extracted_at ASC NULLS FIRST LIMIT %s",
            (limit,),
        )
        return cur.fetchall()


def _update_article(article_id: int, location_id: int, confidence: float) -> None:
    # extracted_lat/lng doubles as the map filter column (the /pins/map
    # predicate is single-table now — FIX_NOTES 8.1). Fill it from the
    # bound location WHEN EMPTY so every bound article is filterable;
    # intentionally-spread coordinates (density) are never overwritten.
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE news_articles a
            SET location_id = %s,
                location_confidence = %s,
                geocoded_at = now(),
                status = 'extracted',
                extracted_lat = COALESCE(NULLIF(a.extracted_lat, 0), l.lat),
                extracted_lng = COALESCE(NULLIF(a.extracted_lng, 0), l.lng)
            FROM news_locations l
            WHERE a.id = %s AND l.id = %s
            """,
            (location_id, confidence, article_id, location_id),
        )


def _bump_geocode_attempt(article_id: int) -> None:
    """Count a transient geocode failure; the queue query stops retrying
    after 5 attempts so poison strings can't churn the cycle forever."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE news_articles SET geocode_attempts = geocode_attempts + 1 WHERE id = %s",
            (article_id,),
        )


def _mark_unlocated(article_id: int) -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE news_articles SET status='unlocated', geocoded_at=now() WHERE id = %s",
            (article_id,),
        )


def _geocode_one_target(
    client: httpx.Client,
    location_text: str,
    *,
    nominatim_url: str = NOMINATIM_URL,
    user_agent: str = USER_AGENT,
    timeout_s: float = TIMEOUT_S,
    country_hint: str | None = None,
) -> dict | None:
    """Lower-level Nominatim caller used by ``Geocoder``.

    Identical to ``geocode_one`` but parameterised so the Geocoder can be
    pointed at a self-hosted mirror without mutating module globals. Kept
    private — public callers should still use ``geocode_one``.
    """
    norm = _normalize_place(location_text)
    if norm in COUNTRY_CAPITALS:
        lat, lng, cc = COUNTRY_CAPITALS[norm]
        return {
            "place_name": location_text,
            "place_name_normalized": norm,
            "country": cc,
            "lat": lat,
            "lng": lng,
            "precision": "country",
            "confidence": 1.0,
            "osm_id": None,
            "osm_type": None,
        }

    params = {
        "q": location_text,
        "format": "json",
        "limit": 1,
        "addressdetails": 1,
    }
    cc_hint = _ambiguous_country_hint(location_text, country_hint)
    if cc_hint:
        params["countrycodes"] = cc_hint
    headers = {"User-Agent": user_agent}
    try:
        resp = client.get(nominatim_url, params=params, headers=headers, timeout=timeout_s)
    except httpx.HTTPError as exc:
        # FIX_NOTES 1.5: transport error is transient — retry next cycle,
        # do NOT mark the article unlocated.
        raise TransientGeocodeError(f"nominatim transport error: {exc}") from exc
    if resp.status_code == 429:
        # We don't sleep here — the surrounding Geocoder throttle decides.
        log.warning("Nominatim HTTP 429 for %r", location_text)
        raise TransientGeocodeError("nominatim 429")
    if resp.status_code != 200:
        log.warning("Nominatim HTTP %s for %r", resp.status_code, location_text)
        raise TransientGeocodeError(f"nominatim HTTP {resp.status_code}")
    rows = resp.json()
    if not rows:
        return None
    top = rows[0]
    try:
        lat = float(top["lat"])
        lng = float(top["lon"])
    except (KeyError, ValueError, TypeError):
        return None
    addr = top.get("address") or {}
    country = addr.get("country")
    precision = _precision_from_class(top.get("class", ""), top.get("type", ""))

    if precision == "country" or top.get("type") == "country":
        country_norm = (country or location_text).lower().strip()
        if country_norm in COUNTRY_CAPITALS:
            lat, lng, _ = COUNTRY_CAPITALS[country_norm]

    return {
        "place_name": location_text,
        "place_name_normalized": norm,
        "country": country,
        "lat": lat,
        "lng": lng,
        "precision": precision,
        "confidence": 1.0,
        "osm_id": int(top["osm_id"]) if top.get("osm_id") and str(top["osm_id"]).isdigit() else None,
        "osm_type": top.get("osm_type"),
    }


# ──────────────────────────────────────────────────────────────────────────────
# Parallel batch geocoder (Audit 3+4)
# ──────────────────────────────────────────────────────────────────────────────


class _RateLimiter:
    """Shared Nominatim throttle for the Geocoder's thread pool.

    All workers call ``acquire()`` before issuing a Nominatim request. The
    first one to grab the lock resets ``last_call_at`` to ``now``; subsequent
    callers sleep until ``MIN_INTERVAL_S`` has elapsed since that call.

    Note: the limiter's granularity is per process. If two Geocoder instances
    run in the same process, share one limiter; if they run in different
    processes (cron vs API), Nominatim's own per-IP throttle is what protects
    the public host.
    """

    def __init__(self, min_interval_s: float):
        self.min_interval_s = min_interval_s
        self._lock = threading.Lock()
        self._last_call_at: float = 0.0

    def acquire(self) -> None:
        if self.min_interval_s <= 0:
            return
        with self._lock:
            now = time.monotonic()
            wait = self.min_interval_s - (now - self._last_call_at)
            if wait > 0:
                time.sleep(wait)
            self._last_call_at = time.monotonic()


class Geocoder:
    """Parallel batch geocoder.

    Each instance owns one ``ThreadPoolExecutor`` and one shared
    ``_RateLimiter``. Use one instance per process — constructors open
    a few connections to ``news_locations`` on first cache fill and you
    don't want multiple instances trampling each other's caches.

    Config knobs (env or kwargs):

      ``NEWSIUM_GEOCODE_WORKERS``  — pool size (default 4)
      ``NEWSIUM_GEOCODE_INTERVAL`` — Nominatim min gap (default 1.1s)
      ``NEWSIUM_GEOCODE_TIMEOUT``  — per-request timeout (default 15s)
      ``NEWSIUM_NOMINATIM_URL``   — Nominatim endpoint override

    Thread safety:
      - The cache is locked with ``_cache_lock``.
      - The rate limiter is locked with ``_RateLimiter._lock``.
      - ``upsert_location`` uses the pool's ``connect()`` context manager,
        which serialises its checkout internally (psycopg_pool).
      - Each worker thread holds its own ``httpx.Client`` because the
        client is not safe to share across threads.
    """

    def __init__(
        self,
        max_workers: int | None = None,
        min_interval_s: float | None = None,
        timeout_s: float | None = None,
        nominatim_url: str | None = None,
        user_agent: str | None = None,
    ):
        self.max_workers = max_workers or MAX_WORKERS
        self.min_interval_s = (
            min_interval_s if min_interval_s is not None else MIN_INTERVAL_S
        )
        self.timeout_s = timeout_s or TIMEOUT_S
        self.nominatim_url = nominatim_url or NOMINATIM_URL
        self.user_agent = user_agent or USER_AGENT
        self._limiter = _RateLimiter(self.min_interval_s)
        self._executor: ThreadPoolExecutor | None = None
        self._cache_lock = threading.Lock()
        self._cache: dict[str, int] = {}

    # ── Executor lifecycle ──────────────────────────────────────────────

    def _ensure_executor(self) -> ThreadPoolExecutor:
        if self._executor is None:
            self._executor = ThreadPoolExecutor(
                max_workers=self.max_workers,
                thread_name_prefix="geocode",
            )
        return self._executor

    def shutdown(self, wait: bool = True) -> None:
        """Release worker threads. Idempotent.

        Mostly useful in tests; the worker process exits at the end of each
        cycle and lets the OS reclaim threads.
        """
        if self._executor is not None:
            self._executor.shutdown(wait=wait)
            self._executor = None

    # ── Cache ──────────────────────────────────────────────────────────

    def prefill_cache(self) -> int:
        """Load every existing ``news_locations`` row into the in-process cache.

        Returns the number of (place_name_normalized -> id) mappings loaded.
        Cheap: one ``SELECT id, place_name_normalized, lat, lng`` against
        ``news_locations``. Called automatically by
        :meth:`geocode_articles` before dispatching workers.
        """
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, place_name_normalized, lat, lng
                FROM news_locations
                WHERE place_name_normalized IS NOT NULL
                """
            )
            loaded = 0
            with self._cache_lock:
                for row in cur.fetchall():
                    norm = row["place_name_normalized"]
                    if norm and norm not in self._cache:
                        self._cache[norm] = row["id"]
                        loaded += 1
        return loaded

    def cache_size(self) -> int:
        with self._cache_lock:
            return len(self._cache)

    def _lookup_cached(self, normalized: str) -> int | None:
        with self._cache_lock:
            return self._cache.get(normalized)

    def _remember(self, normalized: str, location_id: int) -> None:
        with self._cache_lock:
            self._cache.setdefault(normalized, location_id)

    # ── Public API ─────────────────────────────────────────────────────

    def geocode_one(self, location_text: str,
                    country_hint: str | None = None) -> dict | None:
        """Geocode a single location string (sync, throttled).

        Convenience for callers that want a one-shot lookup without
        setting up the batch machinery. Honors the same rate limit
        pool-wide.
        """
        return _geocode_one_target(
            self._make_client(),
            location_text,
            nominatim_url=self.nominatim_url,
            user_agent=self.user_agent,
            timeout_s=self.timeout_s,
            country_hint=country_hint,
        )

    def _make_client(self) -> httpx.Client:
        # Per-call client. Cheap to construct (httpx reuses the underlying
        # connection pool on teardown). Keeps Nominatim calls isolated so
        # we don't have to think about thread safety of a shared Client.
        # limits=_HTTPX_LIMITS shrinks the anyio thread pool — added 2026-09-10.
        return httpx.Client(limits=_HTTPX_LIMITS)

    def _throttled_geocode(self, location_text: str,
                           country_hint: str | None = None) -> dict | None:
        """Acquire the rate slot, then hit Nominatim once."""
        self._limiter.acquire()
        client = self._make_client()
        try:
            return _geocode_one_target(
                client,
                location_text,
                nominatim_url=self.nominatim_url,
                user_agent=self.user_agent,
                timeout_s=self.timeout_s,
                country_hint=country_hint,
            )
        finally:
            client.close()

    def geocode_articles(self, articles: list[dict]) -> list[tuple[dict, dict | None]]:
        """Geocode many articles in parallel.

        Each article is a dict carrying at least ``id`` and
        ``location_text`` (other keys are passed through untouched). Returns
        a list of ``(article, result)`` tuples in input order, where
        ``result`` is either the geocoded dict (``place_name_normalized``,
        ``lat``, ``lng``, …) or ``None`` on failure / no-match.

        Semantics match the legacy ``run()`` exactly: a cached hit updates
        the article's ``location_id`` and reports ``result=None`` with
        ``location_id`` set on the article dict; a Nominatim miss marks the
        article ``status='unlocated'``; a Nominatim hit upserts a
        ``news_locations`` row and binds it via ``location_id``.

        The whole batch is dispatched to a ThreadPoolExecutor. Each worker
        runs ``_process_article`` to completion before yielding its tuple.
        """
        if not articles:
            return []
        # Cache fill once per batch — heavy concurrent cache fills would
        # otherwise fan out into N identical SELECTs.
        self.prefill_cache()

        ex = self._ensure_executor()

        def worker(art: dict) -> tuple[dict, dict | None]:
            return art, self._process_article(art)

        futures = [ex.submit(worker, art) for art in articles]
        # ``as_completed`` would let us stream progress, but callers rely on
        # positional ordering (zip(input, output)). Collect then sort.
        results: list[tuple[dict, dict | None]] = []
        for fut in as_completed(futures):
            try:
                results.append(fut.result())
            except Exception as exc:  # noqa: BLE001
                log.exception("geocode worker crashed: %s", exc)
        # Restore input order — as_completed doesn't preserve it.
        order = {id(a): i for i, a in enumerate(articles)}
        results.sort(key=lambda pair: order.get(id(pair[0]), 1 << 30))
        return results

    def _process_article(self, art: dict) -> dict | None:
        """Geocode one article, writing back to the DB.

        Returns a small dict describing what happened (or None on miss):
          ``{"status": "cached" | "geocoded" | "unlocated" | "skipped",
             "location_id": int, "place_name_normalized": str}``
        """
        art_id = art.get("id")
        place = (art.get("location_text") or "").strip()
        if not place or art_id is None:
            return {"status": "skipped"}

        extracted_lat = art.get("extracted_lat")
        extracted_lng = art.get("extracted_lng")
        if extracted_lat is not None and extracted_lng is not None and extracted_lat != 0:
            existing_loc_id = find_location_by_coords(extracted_lat, extracted_lng)
            if existing_loc_id is not None:
                try:
                    _update_article(art_id, existing_loc_id, 1.0)
                except Exception as exc:  # noqa: BLE001
                    log.warning("direct coord match update failed for id=%s: %s", art_id, exc)
                return {"status": "cached", "location_id": existing_loc_id,
                        "place_name_normalized": f"{extracted_lat},{extracted_lng}"}
            loc = {
                "place_name": place or f"{extracted_lat},{extracted_lng}",
                "place_name_normalized": _normalize_place(place) if place else f"{extracted_lat},{extracted_lng}",
                "country": None,
                "lat": extracted_lat,
                "lng": extracted_lng,
                "precision": "city",
                "confidence": 0.95,
                "osm_id": None,
                "osm_type": None,
            }
            try:
                with connect() as conn, conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO news_locations (
                            place_name, place_name_normalized, country, lat, lng,
                            precision, confidence, osm_id, osm_type, geom
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s,
                                ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography)
                        ON CONFLICT (place_name_normalized, ROUND(lat::numeric, 3), ROUND(lng::numeric, 3))
                        DO UPDATE SET place_name = EXCLUDED.place_name
                        RETURNING id
                        """,
                        (
                            loc["place_name"], loc["place_name_normalized"], loc["country"],
                            loc["lat"], loc["lng"], loc["precision"], loc["confidence"],
                            loc["osm_id"], loc["osm_type"], loc["lng"], loc["lat"],
                        ),
                    )
                    location_id = cur.fetchone()["id"]
                _update_article(art_id, location_id, loc["confidence"])
            except Exception as exc:  # noqa: BLE001
                log.warning("upsert_location from extracted coords failed for id=%s: %s", art_id, exc)
                return {"status": "error", "place_name_normalized": loc["place_name_normalized"]}
            return {
                "status": "geocoded",
                "location_id": location_id,
                "place_name_normalized": loc["place_name_normalized"],
                "lat": extracted_lat,
                "lng": extracted_lng,
            }

        norm = _normalize_place(place)
        cached = self._lookup_cached(norm)
        if cached is not None:
            try:
                _update_article(art_id, cached, 1.0)
            except Exception as exc:  # noqa: BLE001
                log.warning("cached update failed for id=%s: %s", art_id, exc)
            return {"status": "cached", "location_id": cached,
                    "place_name_normalized": norm}

        try:
            loc = self._throttled_geocode(place, country_hint=art.get("source_country"))
        except TransientGeocodeError as exc:
            # FIX_NOTES 1.5: Nominatim was down/limiting — keep the article
            # in the queue (status stays 'extracted', location_id NULL),
            # bounded by geocode_attempts, instead of the old terminal
            # status='unlocated' black hole.
            log.info("transient geocode failure for %r (id=%s): %s", place, art_id, exc)
            try:
                _bump_geocode_attempt(art_id)
            except Exception:  # noqa: BLE001
                pass
            return {"status": "retry", "place_name_normalized": norm}
        if loc is None:
            try:
                _mark_unlocated(art_id)
            except Exception as exc:  # noqa: BLE001
                log.warning("unlocated update failed for id=%s: %s", art_id, exc)
            return {"status": "unlocated", "place_name_normalized": norm}

        try:
            location_id = upsert_location(loc)
        except Exception as exc:  # noqa: BLE001
            log.warning("upsert_location failed for %r: %s", place, exc)
            return {"status": "error", "place_name_normalized": norm}

        self._remember(norm, location_id)
        try:
            _update_article(art_id, location_id, loc["confidence"])
        except Exception as exc:  # noqa: BLE001
            log.warning("update_article failed for id=%s: %s", art_id, exc)
        return {
            "status": "geocoded",
            "location_id": location_id,
            "place_name_normalized": norm,
            "lat": loc.get("lat"),
            "lng": loc.get("lng"),
        }


def run(limit: int = MAX_PER_CYCLE, progress: ProgressWriter | None = None) -> dict:
    """Legacy single-threaded geocoder — preserved for back-compat.

    ``run.py`` and ``fast_update.py`` import this directly. Behaviour is
    unchanged from the pre-Audit-3 release; new code should prefer
    ``Geocoder.geocode_articles`` which is parallel-safe.
    """
    pending = _fetch_needing_geocode(limit)
    log.info("geocode: %d pending (cap %d)", len(pending), limit)
    if progress:
        progress.update(step="geocode", detail=f"Geocoding {len(pending)} articles...")
    summary = {"geocoded": 0, "not_found": 0, "errors": 0, "cached": 0}

    # In-memory cache for this run: int = location_id, None = definitively not found
    # Negative entries expire after 1 hour to avoid permanent negative caching
    import time as _time
    cache: dict[str, tuple[int | None, float]] = {}  # norm -> (location_id or None, timestamp)
    NEGATIVE_CACHE_TTL = 3600.0  # 1 hour

    # Pre-load existing locations to avoid re-geocoding
    try:
        with connect() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT id, place_name_normalized, lat, lng
                FROM news_locations
                WHERE place_name_normalized IS NOT NULL
            """)
            for row in cur.fetchall():
                norm = row["place_name_normalized"]
                if norm and norm not in cache:
                    cache[norm] = (row["id"], 0.0)  # 0.0 = never expires
        log.info("Pre-loaded %d existing locations into cache", len(cache))
    except Exception as e:
        log.warning("Failed to pre-load locations: %s", e)

    with httpx.Client(limits=_HTTPX_LIMITS) as client:
        for idx, art in enumerate(pending, start=1):
            place = (art.get("location_text") or "").strip()
            if not place:
                continue
            norm = _normalize_place(place)

            # Check cache first (includes pre-loaded locations)
            if norm in cache:
                cached_val, cached_time = cache[norm]
                # Check if negative cache entry has expired
                if cached_val is None and (_time.time() - cached_time) > NEGATIVE_CACHE_TTL:
                    del cache[norm]  # Let it retry
                else:
                    if cached_val is not None:
                        _update_article(art["id"], cached_val, 1.0)
                        summary["geocoded"] += 1
                        summary["cached"] += 1
                    else:
                        summary["not_found"] += 1
                    continue

            # Geocode via Nominatim
            try:
                loc = geocode_one(client, place,
                                  country_hint=art.get("source_country"))
            except TransientGeocodeError as exc:
                # FIX_NOTES 1.5: transient — retry next cycle, bounded by
                # geocode_attempts, never park as 'unlocated'.
                log.info("geocode transient for %r: %s", place, exc)
                try:
                    _bump_geocode_attempt(art["id"])
                except Exception:  # noqa: BLE001
                    pass
                summary["errors"] += 1
                continue
            except httpx.HTTPError as exc:
                log.warning("Nominatim error for %r: %s", place, exc)
                summary["errors"] += 1
                time.sleep(MIN_INTERVAL_S)
                continue

            if loc is None:
                # Cache negative result to avoid retrying the same failed location
                cache[norm] = (None, _time.time())
                with connect() as conn, conn.cursor() as cur:
                    cur.execute(
                        "UPDATE news_articles SET status='unlocated', geocoded_at=now() WHERE id = %s",
                        (art["id"],),
                    )
                summary["not_found"] += 1
                continue

            try:
                location_id = upsert_location(loc)
            except Exception as exc:
                log.warning("upsert failed for %r: %s", place, exc)
                summary["errors"] += 1
                continue

            cache[norm] = (location_id, 0.0)  # 0.0 = never expires for positive results
            _update_article(art["id"], location_id, loc["confidence"])
            summary["geocoded"] += 1

            if progress and (idx % 10 == 0 or idx == len(pending)):
                progress.update(
                    step="geocode",
                    detail=f"Geocoded {summary['geocoded']}/{len(pending)} locations ({summary['cached']} cached)",
                    counters={"geocoded": summary["geocoded"], "cached": summary["cached"]},
                )
    return summary


def run_parallel(
    limit: int | None = None,
    max_workers: int | None = None,
    progress: ProgressWriter | None = None,
) -> dict:
    """Run geocode via the parallel batch path.

    Drop-in replacement for ``run()`` used by ``run.py --step geocode`` when
    ``NEWSIUM_GEOCODE_PARALLEL=1`` is set. Fetches at most ``limit``
    articles and dispatches them through a single ``Geocoder`` (which
    manages its own ThreadPoolExecutor and shared rate limiter).

    Returns the same summary keys as ``run()`` (``geocoded``, ``cached``,
    ``not_found``, ``errors``) so callers don't need to branch on summary
    shape.
    """
    cap = limit or MAX_PER_CYCLE
    pending = _fetch_needing_geocode(cap)
    log.info(
        "geocode (parallel): %d pending (cap %d, workers=%s)",
        len(pending), cap, max_workers or MAX_WORKERS,
    )
    if progress:
        progress.update(
            step="geocode", detail=f"Geocoding {len(pending)} articles (parallel)..."
        )
    if not pending:
        return {"geocoded": 0, "not_found": 0, "errors": 0, "cached": 0}

    geocoder = Geocoder(max_workers=max_workers)
    try:
        results = geocoder.geocode_articles(pending)
    finally:
        geocoder.shutdown(wait=True)

    summary = {"geocoded": 0, "not_found": 0, "errors": 0, "cached": 0, "retry": 0}
    for _art, res in results:
        if res is None:
            continue
        st = res.get("status")
        if st == "cached":
            summary["cached"] += 1
            summary["geocoded"] += 1
        elif st == "geocoded":
            summary["geocoded"] += 1
        elif st == "unlocated":
            summary["not_found"] += 1
        elif st == "retry":
            summary["retry"] += 1
        elif st == "error":
            summary["errors"] += 1
        # "skipped" contributes nothing
    if progress:
        progress.update(
            step="geocode",
            detail=(
                f"Geocoded {summary['geocoded']}/{len(pending)} "
                f"({summary['cached']} cached, {summary['not_found']} not found, "
                f"{summary['errors']} errors)"
            ),
            counters={"geocoded": summary["geocoded"], "cached": summary["cached"]},
        )
    return summary


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    print(run())
