"""PostgreSQL query profiler — EXPLAIN ANALYZE on key XYZO queries.

Identifies slow queries, missing indexes, and table bloat.

Usage:
    python -m worker.xyzo_audit.db_profiler /tmp/report
"""
from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

import psycopg2
import psycopg2.extras


DB_DSN = os.environ.get("XYZO_DB_URL") or os.environ.get("XYZO_DB_DSN") or os.environ.get("DATABASE_URL") or "postgres://xyzo_app:CHANGE_ME@localhost:5432/xyzo"


# Key queries to profile — (name, sql, params)
PROFILE_QUERIES = [
    (
        "map_pins_bbox",
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "
        "SELECT p.id, p.category, p.title, "
        "ST_Y(p.location::geometry) as lat, ST_X(p.location::geometry) as lng "
        "FROM pins p "
        "WHERE ST_Y(p.location::geometry) BETWEEN -10 AND -5 "
        "AND ST_X(p.location::geometry) BETWEEN 105 AND 110 "
        "AND p.status = 'published' "
        "ORDER BY p.created_at DESC LIMIT 200",
        None,
    ),
    (
        "feed_hot_events",
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "
        "SELECT e.id, e.event_type, e.headline, e.source_count, "
        "e.primary_location_id, l.lat, l.lng, l.place_name "
        "FROM news_events e "
        "LEFT JOIN news_locations l ON l.id = e.primary_location_id "
        "WHERE e.status = 'active' "
        "AND e.expires_at > now() "
        "ORDER BY e.source_count DESC, e.first_reported_at DESC "
        "LIMIT 30",
        None,
    ),
    (
        "feed_live_articles",
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "
        "SELECT a.id, a.title, a.summary, a.image_url, a.published_at, "
        "a.source_id, s.name as source_name, a.topic_tags, "
        "l.lat, l.lng, l.place_name, l.country "
        "FROM news_articles a "
        "JOIN news_sources s ON s.id = a.source_id "
        "LEFT JOIN news_locations l ON l.id = a.location_id "
        "WHERE a.status = 'extracted' "
        "AND a.published_at > now() - INTERVAL '24 hours' "
        "ORDER BY a.published_at DESC LIMIT 50",
        None,
    ),
    (
        "search_fts",
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "
        "SELECT a.id, a.title, a.summary, a.image_url, "
        "s.name as source_name, l.place_name, l.country "
        "FROM news_articles a "
        "JOIN news_sources s ON s.id = a.source_id "
        "LEFT JOIN news_locations l ON l.id = a.location_id "
        "WHERE a.title ILIKE '%climate%' OR a.summary ILIKE '%climate%' "
        "LIMIT 20",
        None,
    ),
    (
        "events_search",
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "
        "SELECT e.id, e.event_type, e.headline, e.summary, e.source_count, "
        "l.place_name, l.lat, l.lng "
        "FROM news_events e "
        "LEFT JOIN news_locations l ON l.id = e.primary_location_id "
        "WHERE e.headline ILIKE '%flood%' OR e.summary ILIKE '%flood%' "
        "ORDER BY e.source_count DESC LIMIT 20",
        None,
    ),
    (
        "event_clustering",
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "
        "SELECT e.id, e.headline, e.source_count, "
        "l.lat, l.lng, l.place_name "
        "FROM news_events e "
        "JOIN news_locations l ON l.id = e.primary_location_id "
        "WHERE e.status = 'active' "
        "AND l.geom && ST_MakeEnvelope(105, -7, 107, -5, 4326) "
        "ORDER BY e.source_count DESC LIMIT 100",
        None,
    ),
    (
        "source_rankings",
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "
        "SELECT s.name, s.country, s.reliability_score, "
        "COUNT(a.id) as article_count, "
        "MAX(a.published_at) as latest_article "
        "FROM news_sources s "
        "LEFT JOIN news_articles a ON a.source_id = s.id "
        "AND a.published_at > now() - INTERVAL '7 days' "
        "WHERE s.active = TRUE "
        "GROUP BY s.id, s.name, s.country, s.reliability_score "
        "ORDER BY article_count DESC LIMIT 20",
        None,
    ),
    (
        "nn_embeddings_lookup",
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "
        "SELECT article_id, vector "
        "FROM nn_article_embeddings "
        "WHERE article_id IN (SELECT id FROM news_articles WHERE status = 'extracted' ORDER BY published_at DESC LIMIT 100) "
        "LIMIT 50",
        None,
    ),
    (
        "photo_sources_list",
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "
        "SELECT id, name, domain, category, country, robots_status "
        "FROM photo_sources "
        "WHERE active = TRUE "
        "ORDER BY category ASC, name ASC "
        "LIMIT 50 OFFSET 0",
        None,
    ),
    (
        "table_row_counts",
        "SELECT "
        "(SELECT COUNT(*) FROM news_sources WHERE active = TRUE) as active_sources, "
        "(SELECT COUNT(*) FROM news_articles) as total_articles, "
        "(SELECT COUNT(*) FROM news_articles WHERE status = 'extracted') as extracted_articles, "
        "(SELECT COUNT(*) FROM news_events WHERE status = 'active') as active_events, "
        "(SELECT COUNT(*) FROM news_locations) as locations, "
        "(SELECT COUNT(*) FROM photo_sources WHERE active = TRUE) as photo_sources, "
        "(SELECT COUNT(*) FROM nn_article_embeddings) as embeddings, "
        "(SELECT pg_size_pretty(pg_total_relation_size('news_articles'))) as articles_size, "
        "(SELECT pg_size_pretty(pg_total_relation_size('news_events'))) as events_size, "
        "(SELECT pg_size_pretty(pg_total_relation_size('news_locations'))) as locations_size, "
        "(SELECT pg_size_pretty(pg_total_relation_size('nn_article_embeddings'))) as embeddings_size",
        None,
    ),
    (
        "missing_indexes",
        "SELECT schemaname, relname as tablename, idx_scan, idx_tup_read, idx_tup_fetch "
        "FROM pg_stat_user_indexes "
        "WHERE schemaname = 'public' "
        "ORDER BY idx_scan ASC "
        "LIMIT 20",
        None,
    ),
    (
        "connection_usage",
        "SELECT "
        "count(*) as total_connections, "
        "count(*) FILTER (WHERE state = 'active') as active, "
        "count(*) FILTER (WHERE state = 'idle') as idle, "
        "count(*) FILTER (WHERE state = 'idle in transaction') as idle_in_transaction, "
        "max(now() - backend_start)::text as longest_connection "
        "FROM pg_stat_activity "
        "WHERE datname = current_database()",
        None,
    ),
]


@dataclass
class QueryProfile:
    name: str
    planning_ms: float = 0
    execution_ms: float = 0
    total_ms: float = 0
    rows_returned: int = 0
    shared_buffers_hit: int = 0
    shared_buffers_read: int = 0
    seq_scans: int = 0
    idx_scans: int = 0
    flags: list = field(default_factory=list)
    raw_plan: str = ""


@dataclass
class DBReport:
    profiles: list = field(default_factory=list)
    table_stats: dict = field(default_factory=dict)
    missing_indexes: list = field(default_factory=list)
    connection_stats: dict = field(default_factory=dict)
    flags: list = field(default_factory=list)


def parse_explain_json(plan_json: dict) -> dict:
    """Parse EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) output."""
    if not plan_json or not isinstance(plan_json, list):
        return {}

    plan = plan_json[0].get("Plan", {})
    planning = plan_json[0].get("Planning Time", 0)
    execution = plan_json[0].get("Execution Time", 0)

    # Recursively find scan types and buffer stats
    def walk(node, stats=None):
        if stats is None:
            stats = {"seq_scans": 0, "idx_scans": 0, "shared_hit": 0, "shared_read": 0}

        node_type = node.get("Node Type", "")
        if "Seq Scan" in node_type:
            stats["seq_scans"] += 1
        elif "Index" in node_type:
            stats["idx_scans"] += 1

        bs = node.get("Shared Buffers", {})
        stats["shared_hit"] += bs.get("Hit", 0)
        stats["shared_read"] += bs.get("Read", 0)

        for child in node.get("Plans", []):
            walk(child, stats)
        return stats

    stats = walk(plan)

    return {
        "planning_ms": round(planning, 3),
        "execution_ms": round(execution, 3),
        "total_ms": round(planning + execution, 3),
        "rows": plan.get("Actual Rows", 0),
        "shared_hit": stats["shared_hit"],
        "shared_read": stats["shared_read"],
        "seq_scans": stats["seq_scans"],
        "idx_scans": stats["idx_scans"],
    }


def run_db_profiler(report_dir: str) -> DBReport:
    """Profile all key queries."""
    report = DBReport()

    conn = psycopg2.connect(DB_DSN)
    conn.autocommit = True

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        for name, sql, params in PROFILE_QUERIES:
            try:
                t0 = time.monotonic()
                cur.execute(sql, params)
                rows = cur.fetchall()
                exec_time = (time.monotonic() - t0) * 1000

                if name in ("table_row_counts", "missing_indexes", "connection_usage"):
                    # Non-profile queries
                    if name == "table_row_counts":
                        report.table_stats = dict(rows[0]) if rows else {}
                    elif name == "missing_indexes":
                        report.missing_indexes = [dict(r) for r in rows]
                    elif name == "connection_usage":
                        report.connection_stats = dict(rows[0]) if rows else {}
                    continue

                # Parse EXPLAIN output
                plan_json = rows[0].get("QUERY PLAN") if rows else None
                if isinstance(plan_json, str):
                    plan_json = json.loads(plan_json)

                parsed = parse_explain_json(plan_json)

                profile = QueryProfile(
                    name=name,
                    planning_ms=parsed.get("planning_ms", 0),
                    execution_ms=parsed.get("execution_ms", 0),
                    total_ms=round(exec_time, 1),
                    rows_returned=parsed.get("rows", 0),
                    shared_buffers_hit=parsed.get("shared_hit", 0),
                    shared_buffers_read=parsed.get("shared_read", 0),
                    seq_scans=parsed.get("seq_scans", 0),
                    idx_scans=parsed.get("idx_scans", 0),
                )

                # Flag issues
                if profile.execution_ms > 500:
                    profile.flags.append("CRITICAL_SLOW")
                elif profile.execution_ms > 100:
                    profile.flags.append("SLOW")
                if profile.seq_scans > 0 and profile.idx_scans == 0:
                    profile.flags.append("SEQ_SCAN_NO_INDEX")
                if profile.shared_buffers_read > profile.shared_buffers_hit and profile.shared_buffers_hit > 0:
                    profile.flags.append("LOW_CACHE_HIT")

                report.profiles.append(profile)

            except Exception as e:
                report.profiles.append(QueryProfile(
                    name=name,
                    flags=[f"ERROR: {str(e)[:100]}"],
                ))

    # Global flags
    slow_queries = [p for p in report.profiles if any(f.startswith("SLOW") or f.startswith("CRITICAL") for f in p.flags)]
    seq_scans = [p for p in report.profiles if "SEQ_SCAN_NO_INDEX" in p.flags]

    if slow_queries:
        report.flags.append(f"SLOW_QUERIES: {len(slow_queries)}")
    if seq_scans:
        report.flags.append(f"SEQ_SCANS_MISSING_INDEX: {len(seq_scans)}")

    conn.close()

    Path(report_dir).mkdir(parents=True, exist_ok=True)
    with open(Path(report_dir) / "07-db-profile.json", "w") as f:
        json.dump(asdict(report), f, indent=2, default=str)

    return report


def main():
    report_dir = sys.argv[1] if len(sys.argv) > 1 else "/tmp/xyzo-audit"

    print("  DB profiler: connecting...")
    report = run_db_profiler(report_dir)

    print(f"  Queries profiled: {len(report.profiles)}")
    for p in report.profiles:
        status = "✓" if not p.flags else "✗"
        print(f"    {status} {p.name}: {p.total_ms}ms ({p.rows_returned} rows) {' '.join(p.flags)}")

    if report.table_stats:
        print(f"\n  Table stats:")
        for k, v in report.table_stats.items():
            print(f"    {k}: {v}")

    if report.flags:
        print(f"\n  Flags:")
        for f in report.flags:
            print(f"    {f}")


if __name__ == "__main__":
    main()
