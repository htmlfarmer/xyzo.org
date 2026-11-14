"""PostgreSQL → API → Browser tracing diagnostics.

Traces a request end-to-end:
  1. What the browser requested (URL, params)
  2. What the API received and processed
  3. What SQL queries were executed
  4. What the database returned
  5. What the API sent back
  6. What the frontend rendered

Usage:
    db_diag = DBDiagnostics()
    result = db_diag.trace_pins_request(bbox="105.0,-7.0,107.0,-5.0", limit=5000)
    print(result.summary())
"""

from __future__ import annotations

import httpx
import json
import logging
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any

from ..db import connect

log = logging.getLogger("xyzo.db_diagnostics")

XYZO_API = "http://localhost:3008"


@dataclass
class SQLQuery:
    query: str
    params: tuple | list | None = None
    duration_ms: float | None = None
    row_count: int | None = None


@dataclass
class DBTraceResult:
    sql_queries: list[SQLQuery] = field(default_factory=list)
    db_found: int | None = None
    api_returned: int | None = None
    api_response_size_b: int | None = None
    db_time_ms: float | None = None
    api_time_ms: float | None = None
    bbox: str = ""
    limit: int = 0
    zoom: int | None = None
    response_body: dict | None = None


@dataclass
class PinCountBreakdown:
    database_records: int | None = None
    api_returned: int | None = None
    frontend_received: int | None = None
    frontend_rendered: int | None = None
    bbox: str = ""
    limit: int = 0


class DBDiagnostics:
    """Trace XYZO requests through all layers."""

    def __init__(self, api_base: str = XYZO_API):
        self.api_base = api_base
        self._dsn = os.environ.get("XYZO_DB_DSN", "postgres://xyzo_app:CHANGE_ME@localhost:5432/xyzo")

    def _query_db(self, bbox: str, limit: int) -> tuple[int, list[SQLQuery], float]:
        """Run the pins query directly against the DB and return count + queries + time.

        Mirrors the actual API deduplication logic:
          1. ranked: one per location (loc_rank), max 100 per location
          2. deduped: one per event+location (event_rank)
        """
        import re
        queries: list[SQLQuery] = []
        t0 = time.monotonic()

        with connect() as conn, conn.cursor() as cur:
            cur.execute("SET statement_timeout = '10s'")

            parts = bbox.split(",")
            if len(parts) != 4:
                raise ValueError(f"Invalid bbox: {bbox}")
            min_lng, min_lat, max_lng, max_lat = map(float, parts)

            # Exact API deduplication: two-level ranking
            count_query = """
                WITH ranked_articles AS (
                    SELECT a.id, a.location_id, a.fetched_at,
                           nes.event_id AS article_event_id,
                           ROW_NUMBER() OVER (
                               PARTITION BY a.location_id
                               ORDER BY a.fetched_at DESC
                           ) AS loc_rank
                    FROM news_articles a
                    JOIN news_locations l ON l.id = a.location_id
                    LEFT JOIN news_event_sources nes ON nes.article_id = a.id
                    WHERE a.status = 'extracted'
                      AND a.location_id IS NOT NULL
                      AND l.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
                ),
                deduped_articles AS (
                    SELECT *,
                        ROW_NUMBER() OVER (
                            PARTITION BY COALESCE(article_event_id, location_id)
                            ORDER BY fetched_at DESC
                        ) AS event_rank
                    FROM ranked_articles
                    WHERE loc_rank <= 100
                )
                SELECT COUNT(*) FROM deduped_articles WHERE event_rank = 1
            """
            cur.execute(count_query, (min_lng, min_lat, max_lng, max_lat))
            count = cur.fetchone()["count"]

            # Raw article count (before dedup)
            cur.execute("""
                SELECT COUNT(*) FROM news_articles a
                JOIN news_locations l ON l.id = a.location_id
                WHERE a.status = 'extracted'
                  AND a.location_id IS NOT NULL
                  AND l.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
            """, (min_lng, min_lat, max_lng, max_lat))
            raw_count = cur.fetchone()["count"]

            # Distinct locations
            cur.execute("""
                SELECT COUNT(DISTINCT a.location_id) FROM news_articles a
                JOIN news_locations l ON l.id = a.location_id
                WHERE a.status = 'extracted'
                  AND a.location_id IS NOT NULL
                  AND l.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
            """, (min_lng, min_lat, max_lng, max_lat))
            distinct_locs = cur.fetchone()["count"]

            # Top locations by article count
            cur.execute("""
                SELECT a.location_id, l.place_name, l.lat, l.lng, COUNT(*) as article_count
                FROM news_articles a
                JOIN news_locations l ON l.id = a.location_id
                WHERE a.status = 'extracted'
                  AND a.location_id IS NOT NULL
                  AND l.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
                GROUP BY a.location_id, l.place_name, l.lat, l.lng
                ORDER BY article_count DESC
                LIMIT 20
            """, (min_lng, min_lat, max_lng, max_lat))
            top_locations = cur.fetchall()

        elapsed_ms = (time.monotonic() - t0) * 1000

        queries.append(SQLQuery(
            query=re.sub(r'\s+', ' ', count_query).strip(),
            params=(min_lng, min_lat, max_lng, max_lat),
            duration_ms=elapsed_ms,
            row_count=count,
        ))

        # Store extra stats for reporting
        self._last_raw_count = raw_count
        self._last_distinct_locs = distinct_locs

        return count, queries, elapsed_ms

    def trace_pins_api(self, bbox: str, limit: int = 2000, timeout: float = 60.0) -> DBTraceResult:
        limit = min(limit, 2000)  # Enforce API max
        """Make the actual API request and trace what the DB saw."""
        import os
        dsn = os.environ.get("XYZO_DB_DSN", self._dsn)

        db_count, queries, db_time = self._query_db(bbox, limit)

        t0 = time.monotonic()
        url = f"{self.api_base}/api/pins/map?bbox={bbox}&limit={limit}"
        try:
            resp = httpx.get(url, timeout=timeout, trust_env=False)
            api_time_ms = (time.monotonic() - t0) * 1000
            resp.raise_for_status()
            body = resp.json()
            if isinstance(body, dict):
                api_count = body.get("count", len(body.get("pins", [])))
            elif isinstance(body, list):
                api_count = len(body)
            else:
                api_count = None
            api_size = len(resp.content)
        except Exception as e:
            api_time_ms = (time.monotonic() - t0) * 1000
            api_count = None
            api_size = 0
            body = {"error": str(e), "type": type(e).__name__}

        result = DBTraceResult(
            bbox=bbox,
            limit=limit,
            db_found=db_count,
            api_returned=api_count,
            api_response_size_b=api_size,
            db_time_ms=db_time,
            api_time_ms=api_time_ms,
            sql_queries=queries,
            response_body=body,
        )
        return result

    def compare_desktop_mobile(self, bbox: str) -> dict:
        """Compare what desktop (limit 5000) vs mobile (limit 500) receives."""
        desktop = self.trace_pins_api(bbox, limit=5000)
        mobile = self.trace_pins_api(bbox, limit=500)
        return {
            "bbox": bbox,
            "desktop": {
                "limit": desktop.limit,
                "db_found": desktop.db_found,
                "api_returned": desktop.api_returned,
                "api_time_ms": round(desktop.api_time_ms, 1) if desktop.api_time_ms else None,
            },
            "mobile": {
                "limit": mobile.limit,
                "db_found": mobile.db_found,
                "api_returned": mobile.api_returned,
                "api_time_ms": round(mobile.api_time_ms, 1) if mobile.api_time_ms else None,
            },
            "discrepancy": desktop.api_returned != mobile.api_returned,
        }

    def find_pagination_bug(self, bbox: str) -> dict:
        """Check if API properly handles multi-request pagination scenarios."""
        result = self.trace_pins_api(bbox, limit=500)
        return {
            "bbox": bbox,
            "limit_used": 500,
            "db_found": result.db_found,
            "api_returned": result.api_returned,
            "api_time_ms": round(result.api_time_ms, 1) if result.api_time_ms else None,
            "api_response_has_count": isinstance(result.response_body, dict) and "count" in result.response_body,
            "has_more": isinstance(result.response_body, dict) and result.response_body.get("has_more", False),
            "pagination_correct": result.db_found is not None and result.api_returned is not None
                and result.api_returned <= result.db_found
                and result.api_returned <= 500,
        }

    def explain_pin_query(self, bbox: str) -> dict:
        """Get EXPLAIN ANALYZE of the pin query for a bbox."""
        with connect() as conn, conn.cursor() as cur:
            parts = bbox.split(",")
            min_lng, min_lat, max_lng, max_lat = map(float, parts)

            cur.execute("""
                EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
                SELECT a.id, a.title, a.url, a.fetched_at,
                       a.location_id, a.category, a.source_type,
                       ST_X(a.location::geometry) as lng,
                       ST_Y(a.location::geometry) as lat,
                       l.place_name, l.country
                FROM news_articles a
                JOIN news_locations l ON l.id = a.location_id
                WHERE a.status = 'extracted'
                  AND a.location_id IS NOT NULL
                  AND l.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
                ORDER BY a.fetched_at DESC
                LIMIT 5000
            """, (min_lng, min_lat, max_lng, max_lat))
            explain = cur.fetchone()[0]
            return explain

    def print_trace(self, result: DBTraceResult) -> str:
        db_found = f"{result.db_found:,}" if result.db_found is not None else "N/A"
        api_returned = f"{result.api_returned:,}" if result.api_returned is not None else "N/A"
        lines = [
            "╔══════════════════════════════════════════════════════╗",
            "║              XYZO PIN TRACE RESULTS                  ║",
            "╚══════════════════════════════════════════════════════╝",
            f"  BBOX:        {result.bbox}",
            f"  Limit:       {result.limit}",
            f"  DB found:    {db_found} records",
            f"  API returned: {api_returned} records",
            f"  DB time:     {result.db_time_ms:.1f}ms" if result.db_time_ms else "  DB time:     N/A",
            f"  API time:    {result.api_time_ms:.1f}ms" if result.api_time_ms else "  API time:    N/A",
            f"  Response:    {result.api_response_size_b:,} bytes" if result.api_response_size_b else "  Response:    N/A",
            "",
        ]
        if result.sql_queries:
            lines.append("  SQL Queries:")
            for q in result.sql_queries:
                lines.append(f"    [{q.duration_ms:.1f}ms] {q.query[:80]}")
        if result.response_body and isinstance(result.response_body, dict) and result.response_body.get("error"):
            lines.append(f"\n  API Error: {result.response_body.get('error')} ({result.response_body.get('type', '?')})")
        if result.db_found and result.api_returned:
            if result.api_returned > result.db_found:
                lines.append(f"\n  ⚠ API returned MORE than DB found — possible bug!")
            elif result.api_returned < result.db_found:
                lines.append(f"\n  ⚠ DB had {result.db_found - result.api_returned:,} records not returned by API")
        return "\n".join(lines)


def main():
    import argparse
    parser = argparse.ArgumentParser(description="XYZO DB Diagnostics")
    parser.add_argument("--bbox", default="105.0,-7.0,107.0,-5.0", help="Bounding box")
    parser.add_argument("--limit", type=int, default=2000, help="Max records (API limit: 2000)")
    parser.add_argument("--compare", action="store_true", help="Compare desktop vs mobile limits")
    parser.add_argument("--explain", action="store_true", help="Show EXPLAIN ANALYZE")
    parser.add_argument("--pagination-check", action="store_true", help="Check pagination correctness")
    args = parser.parse_args()

    diag = DBDiagnostics()

    if args.compare:
        result = diag.compare_desktop_mobile(args.bbox)
        print(json.dumps(result, indent=2))
    elif args.explain:
        result = diag.explain_pin_query(args.bbox)
        print(json.dumps(result, indent=2))
    elif args.pagination_check:
        result = diag.find_pagination_bug(args.bbox)
        print(json.dumps(result, indent=2))
    else:
        result = diag.trace_pins_api(args.bbox, args.limit)
        print(diag.print_trace(result))


if __name__ == "__main__":
    raise SystemExit(main())
