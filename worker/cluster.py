"""Event clusterer — groups located articles into news_events.

Heuristic: an article joins an existing event when the existing event has
- the same primary_location_id
- the same event_type
- and an occurred_at within CLUSTER_WINDOW_HOURS of the article's reference time

Otherwise a new event is created. Native-coord articles (extracted_lat/lng)
are inserted as their own events without going through the match step —
they have no fetched_at windows to merge against naturally.

"Why cluster at all?"
Because 5 news sources covering the same earthquake shouldn't create 5
separate pins on the map. They should create 1 pin with 5 sources.
That's what clustering does — it's the AI-powered "same energy" detector.
"""
import logging
from datetime import datetime, timedelta, timezone

from .db import connect

log = logging.getLogger("newsium.cluster")

CLUSTER_WINDOW_HOURS = 6
# If two articles about the same thing are more than 6 hours apart,
# they're probably different events. Weather stories are the exception
# — tomorrow's forecast is still "the same story" as today's.

# How long each event_type stays "fresh enough" to surface on the map.
# Override per-event if AI extraction later produces a relevance_days hint.
#
# "Why does conflict last 90 days but weather only 1?"
# Because wars don't end in a day, but weather forecasts do.
# Also, science stories stay relevant for 30 days because papers
# take a while to become obsolete. Sports games are done in a day
# unless you're still arguing about the referee's call.
RELEVANCE_DEFAULTS: dict[str, int] = {
    "weather":      1,    # today/tomorrow's forecast
    "sports":       1,    # game result, transfer
    "crime":        7,    # active investigation
    "politics":     3,    # fresh policy / statement
    "business":     3,    # market / earnings / deal
    "technology":   7,    # product launch, outage
    "science":      30,   # paper / discovery
    "culture":      14,   # release / award
    "health":       30,   # outbreak guidance / trial
    "environment":  30,   # advisory / spill
    "humanitarian": 14,   # appeal / migration wave
    "disaster":     7,    # post-event coverage
    "conflict":     90,   # war / sustained offensive
    "other":        7,
}


def relevance_for(event_type: str | None) -> int:
    return RELEVANCE_DEFAULTS.get((event_type or "other").lower(), 7)


def _ref_time(row: dict) -> datetime:
    """Article's reference timestamp: published_at, fetched_at, or now()."""
    ts = row.get("published_at") or row.get("fetched_at") or row.get("extracted_at")
    if ts is None:
        return datetime.now(timezone.utc)
    if ts.tzinfo is None:
        return ts.replace(tzinfo=timezone.utc)
    return ts


def _find_match(cur, location_id: int, event_type: str, ref: datetime) -> dict | None:
    cur.execute(
        """
        SELECT id, source_count, avg_confidence
        FROM news_events
        WHERE primary_location_id = %s
          AND event_type = %s
          AND status = 'active'
          AND occurred_at IS NOT NULL
          AND occurred_at BETWEEN %s AND %s
        ORDER BY occurred_at DESC
        LIMIT 1
        """,
        (
            location_id, event_type,
            ref - timedelta(hours=CLUSTER_WINDOW_HOURS),
            ref + timedelta(hours=CLUSTER_WINDOW_HOURS),
        ),
    )
    return cur.fetchone()


def _create_event(cur, article: dict, location_id: int, ref: datetime) -> int:
    event_type = article.get("event_type") or "other"
    days = relevance_for(event_type)
    cur.execute(
        """
        INSERT INTO news_events (
            primary_location_id, event_type, headline, summary,
            occurred_at, first_reported_at, source_count, avg_confidence, status,
            relevance_days, expires_at
        )
        VALUES (%s, %s, %s, %s, %s, now(), 1, 1.0, 'active',
                %s, now() + (%s * interval '1 day'))
        RETURNING id
        """,
        (
            location_id,
            event_type,
            article["title"][:300],
            article.get("summary"),
            ref,
            days,
            days,
        ),
    )
    return cur.fetchone()["id"]


def _attach_source(cur, event_id: int, article_id: int) -> None:
    cur.execute(
        "INSERT INTO news_event_sources (event_id, article_id) VALUES (%s, %s) "
        "ON CONFLICT (event_id, article_id) DO NOTHING",
        (event_id, article_id),
    )


def _attach_location(cur, event_id: int, location_id: int, role: str) -> None:
    cur.execute(
        "INSERT INTO news_event_locations (event_id, location_id, role) VALUES (%s, %s, %s) "
        "ON CONFLICT DO NOTHING",
        (event_id, location_id, role),
    )


def _upsert_entity(cur, name: str, type_: str) -> int:
    cur.execute(
        "INSERT INTO news_entities (name, type) VALUES (%s, %s) "
        "ON CONFLICT (name, type) DO UPDATE SET name = EXCLUDED.name "
        "RETURNING id",
        (name, type_),
    )
    return cur.fetchone()["id"]


def _attach_entities(cur, event_id: int, entities: list[str]) -> None:
    for raw in entities or []:
        if not raw or not isinstance(raw, str):
            continue
        name = raw.strip()[:200]
        if not name:
            continue
        # Best-effort entity type guess
        type_ = "organization" if any(k in name.lower() for k in (
            "ministry", "police", "government", "agency", "corp", "inc", "ltd", "company", "army", "nato", "un"
        )) else "person"
        eid = _upsert_entity(cur, name, type_)
        cur.execute(
            "INSERT INTO news_event_entities (event_id, entity_id) VALUES (%s, %s) "
            "ON CONFLICT DO NOTHING",
            (event_id, eid),
        )


def _upsert_topic(cur, slug: str, label: str | None = None) -> int:
    cur.execute(
        "INSERT INTO news_topics (slug, label) VALUES (%s, %s) "
        "ON CONFLICT (slug) DO UPDATE SET label = COALESCE(EXCLUDED.label, news_topics.label) "
        "RETURNING id",
        (slug.lower(), label or slug.title()),
    )
    return cur.fetchone()["id"]


def _attach_topics(cur, event_id: int, topics: list[str], article_id: int | None = None) -> None:
    for t in topics or []:
        if not t or not isinstance(t, str):
            continue
        slug = t.strip().lower().replace(" ", "-")[:60]
        if not slug:
            continue
        tid = _upsert_topic(cur, slug)
        cur.execute(
            "INSERT INTO news_event_topics (event_id, topic_id) VALUES (%s, %s) "
            "ON CONFLICT DO NOTHING",
            (event_id, tid),
        )
        if article_id is not None:
            cur.execute(
                "INSERT INTO news_article_topics (article_id, topic_id) VALUES (%s, %s) "
                "ON CONFLICT DO NOTHING",
                (article_id, tid),
            )


def _rollup(cur, event_id: int) -> None:
    cur.execute(
        """
        UPDATE news_events e
        SET source_count = (SELECT COUNT(*) FROM news_event_sources s WHERE s.event_id = e.id),
            avg_confidence = (
                SELECT COALESCE(AVG(a.location_confidence), 0.0)
                FROM news_event_sources s
                JOIN news_articles a ON a.id = s.article_id
                WHERE s.event_id = e.id
            )
        WHERE e.id = %s
        """,
        (event_id,),
    )


def _fetch_unclustered(limit: int) -> list[dict]:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, title, summary, event_type, location_id, entities, topic_tags,
                   published_at, fetched_at, extracted_at
            FROM news_articles
            WHERE status = 'extracted'
              AND location_id IS NOT NULL
              AND clustered_at IS NULL
            ORDER BY COALESCE(published_at, fetched_at) ASC
            LIMIT %s
            """,
            (limit,),
        )
        return cur.fetchall()


def _mark_clustered(article_id: int) -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("UPDATE news_articles SET clustered_at = now() WHERE id = %s", (article_id,))


# Advisory lock key (arbitrary constant, namespace "xyzo-cluster").
_CLUSTER_LOCK_KEY = 0x58595A01  # "XYZ" + 01


def run(limit: int = 100) -> dict:
    # FIX_NOTES 6.6: fast-fetcher (*/5m) and full-fetcher (*/15m) can both
    # run cluster concurrently; the same unclustered article was matched /
    # event-created twice in the overlapping window, producing duplicate
    # events. One clusterer at a time: a second concurrent run skips.
    return _run_locked(limit)


def _run_locked(limit: int) -> dict:
    with connect() as lock_conn:
        got = lock_conn.execute(
            "SELECT pg_try_advisory_lock(%s) AS got", (_CLUSTER_LOCK_KEY,)
        ).fetchone()["got"]
        if not got:
            log.info("cluster: another cluster run holds the advisory lock — skipping")
            return {"events_created": 0, "events_merged": 0, "skipped_locked": True}
        try:
            return _run_inner(limit)
        finally:
            lock_conn.execute(
                "SELECT pg_advisory_unlock(%s)", (_CLUSTER_LOCK_KEY,)
            )


def _run_inner(limit: int) -> dict:
    pending = _fetch_unclustered(limit)
    log.info("cluster: %d pending (cap %d)", len(pending), limit)
    summary = {"events_created": 0, "events_merged": 0}
    with connect() as conn:
        with conn.cursor() as cur:
            for art in pending:
                ref = _ref_time(art)
                match = _find_match(cur, art["location_id"], art.get("event_type") or "other", ref)
                if match:
                    event_id = match["id"]
                    summary["events_merged"] += 1
                else:
                    event_id = _create_event(cur, art, art["location_id"], ref)
                    summary["events_created"] += 1
                _attach_source(cur, event_id, art["id"])
                _attach_location(cur, event_id, art["location_id"], "primary")
                _attach_entities(cur, event_id, art.get("entities") or [])
                _attach_topics(cur, event_id, art.get("topic_tags") or [], article_id=art["id"])
                _rollup(cur, event_id)
        conn.commit()
    for art in pending:
        _mark_clustered(art["id"])
    return summary


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    print(run())
