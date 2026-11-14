// ── events_calendar.ts ──────────────────────────────────────────────
//
// Public-facing endpoints for the upcoming-events pipeline:
//   GET  /api/upcoming-events              — list with filters
//   GET  /api/upcoming-events/near         — radius search
//   GET  /api/upcoming-events/:id          — detail
//   GET  /api/events/sources               — list enabled sources
//   POST /api/event-submissions            — submit a new event
//   GET  /api/event-submissions/mine       — list my submissions
//   POST /api/searches/save                — save a search
//   GET  /api/searches/saved               — list my saved searches
//
// All queries use PostGIS ST_DWithin for radius search and the GiST
// index on (lat, lng) that pre-existed from the relational migration.
//
// ETag + Cache-Control headers are set on list endpoints to keep the
// map fast even when the user pans across event-heavy regions.

import { Hono } from "hono";
import { getDb } from "../db";

const sql = (() => {
    // Use the postgres.js tagged-template literal directly via getDb().
    // (getDb returns the same Sql instance the rest of the API uses.)
    const client = getDb();
    return client;
})();

function hashQuery(_q: Record<string, unknown>): string {
    // Stable hash from a query-object for ETag keys. Avoid the need for
    // a crypto dependency in this file.
    const sorted = Object.keys(_q).sort()
        .map(k => `${k}=${String(_q[k] ?? "")}`).join("&");
    let h = 0;
    for (let i = 0; i < sorted.length; i++) {
        h = ((h << 5) - h) + sorted.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h).toString(36);
}

// postgres.js returns BIGSERIAL as BigInt; JSON.stringify can't
// serialise those. Walk the row and coerce every `id`/`count` value
// to Number on the way out.
function sanitizeBigInts<T>(rows: T[]): T[] {
    return rows.map((r: any) => {
        if (r && typeof r === "object") {
            for (const k of Object.keys(r)) {
                if (typeof r[k] === "bigint") r[k] = Number(r[k]);
            }
        }
        return r;
    });
}

function jsonSafe(c: any, body: any, status = 200) {
    const text = JSON.stringify(body, (_k, v) =>
        typeof v === "bigint" ? Number(v) : v
    );
    return c.text(text, status, {
        "Content-Type": "application/json; charset=utf-8",
    });
}

export const upcomingEventsRoute = new Hono();

// ── list upcoming events ────────────────────────────────────────────
upcomingEventsRoute.get("/upcoming-events", async (c) => {
    const q = c.req.query();
    const limit = Math.min(Math.max(Number(q.limit ?? 60), 1), 200);
    const offset = Math.max(Number(q.offset ?? 0), 0);

    // Filters
    const where: ReturnType<typeof sql>[] = [];
    where.push(sql`starts_at > now() - interval '1 day'`);
    if (q.category) {
        where.push(sql`category = ${q.category}`);
    }
    if (q.subcategory) {
        where.push(sql`subcategory = ${q.subcategory}`);
    }
    if (q.event_type) {
        where.push(sql`event_type = ${q.event_type}`);
    }
    if (q.city) {
        where.push(sql`lower(city) = lower(${q.city})`);
    }
    if (q.country_code) {
        where.push(sql`country_code = upper(${q.country_code})`);
    }
    if (q.state) {
        where.push(sql`state = upper(${q.state})`);
    }
    if (q.is_free !== undefined) {
        where.push(sql`is_free = ${q.is_free === "true"}`);
    }
    if (q.q) {
        // Full-text search across title/description/city
        where.push(sql`to_tsvector('english', coalesce(title,'') || ' ' ||
            coalesce(description,'') || ' ' || coalesce(city,''))
            @@ plainto_tsquery('english', ${q.q})`);
    }

    // Date range
    if (q.from) {
        where.push(sql`starts_at >= ${q.from}`);
    }
    if (q.until) {
        where.push(sql`starts_at <= ${q.until}`);
    }

    // Source priority filter
    if (q.source_priority) {
        where.push(sql`source_priority <= ${Number(q.source_priority)}`);
    }

    const whereSql = where.length
        ? sql`WHERE ${where.reduce((acc, w, i) =>
            i === 0 ? w : sql`${acc} AND ${w}`, sql``)}`
        : sql``;

    // ETag hash from filter set
    const tagSrc = hashQuery({
        limit, offset, ...q,
    });
    const etag = `"events-${tagSrc}"`;

    if (c.req.header("if-none-match") === etag) {
        return c.newResponse(null, 304);
    }

    const rows = await sql<Record<string, unknown>[]>`
        SELECT id, source, source_url, title, description,
               category, subcategory, event_type,
               venue_name, venue_address, city, region, state, country,
               country_code, lat, lng, timezone,
               starts_at, ends_at, is_online, is_free, price, currency,
               image_url, organizer_name, organizer_url, registration_url,
               tags, keywords, source_priority, source_domain,
               discovered_at, last_seen_at
        FROM upcoming_events
        ${whereSql}
        ORDER BY
            CASE WHEN source_priority IS NULL THEN 100 ELSE source_priority END ASC,
            starts_at ASC
        LIMIT ${limit} OFFSET ${offset}
    `;

    c.header("ETag", etag);
    c.header("Cache-Control",
        "public, max-age=60, stale-while-revalidate=300");

    return jsonSafe(c,{ ok: true, count: rows.length, events: rows });
});

// ── radius search ───────────────────────────────────────────────────
upcomingEventsRoute.get("/upcoming-events/near", async (c) => {
    const q = c.req.query();
    const lat = Number(q.lat);
    const lng = Number(q.lng);
    if (!isFinite(lat) || !isFinite(lng)) {
        return jsonSafe(c,{ ok: false, error: "lat/lng required" }, 400);
    }
    const radius_km = Math.min(Math.max(Number(q.radius_km ?? 50), 1), 500);
    const radius_m = radius_km * 1000;
    const limit = Math.min(Math.max(Number(q.limit ?? 80), 1), 200);
    const days = Math.min(Math.max(Number(q.days ?? 90), 1), 365);

    const tagSrc = hashQuery({ lat, lng, radius_km, days, limit, ...q });
    const etag = `"events-near-${tagSrc}"`;
    if (c.req.header("if-none-match") === etag) {
        return c.newResponse(null, 304);
    }

    const rows = await sql<Record<string, unknown>[]>`
        WITH center AS (
            SELECT ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography AS geog
        )
        SELECT e.id, e.source, e.source_url, e.title, e.description,
               e.category, e.subcategory, e.event_type,
               e.venue_name, e.venue_address, e.city, e.region, e.state,
               e.country, e.country_code,
               e.starts_at, e.ends_at, e.is_online, e.is_free, e.price,
               e.currency, e.image_url, e.organizer_name, e.tags,
               e.source_priority, e.source_domain,
               ST_Distance(
                   ST_SetSRID(ST_MakePoint(e.lng, e.lat), 4326)::geography,
                   c.geog
               ) / 1000.0 AS distance_km
        FROM upcoming_events e, center c
        WHERE e.lat IS NOT NULL AND e.lng IS NOT NULL
          AND e.starts_at > now()
          AND e.starts_at < now() + (${days} || ' days')::interval
          AND ST_DWithin(
              ST_SetSRID(ST_MakePoint(e.lng, e.lat), 4326)::geography,
              c.geog,
              ${radius_m}
          )
        ORDER BY e.starts_at ASC, distance_km ASC
        LIMIT ${limit}
    `;

    c.header("ETag", etag);
    c.header("Cache-Control",
        "public, max-age=30, stale-while-revalidate=120");

    return jsonSafe(c,{
        ok: true,
        center: { lat, lng },
        radius_km,
        days,
        count: rows.length,
        events: rows,
    });
});

// ── detail ──────────────────────────────────────────────────────────
upcomingEventsRoute.get("/upcoming-events/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) {
        return jsonSafe(c,{ ok: false, error: "invalid id" }, 400);
    }
    const rows = await sql<Record<string, unknown>[]>`
        SELECT e.*,
               v.name AS venue_name_join,
               v.address AS venue_address_join,
               v.website_url AS venue_website_url,
               v.lat AS venue_lat,
               v.lng AS venue_lng,
               o.name AS organizer_name_join,
               o.website_url AS organizer_website_join,
               o.kind AS organizer_kind,
               es.speaker_names,
               es.artist_names,
               es.performer_names,
               et.topic_slugs
        FROM upcoming_events e
        LEFT JOIN event_venues     ev ON ev.event_id = e.id AND ev.is_primary
        LEFT JOIN venues           v  ON v.id       = ev.venue_id
        LEFT JOIN event_organizers eo ON eo.event_id = e.id AND eo.is_primary
        LEFT JOIN organizers       o  ON o.id       = eo.organizer_id
        LEFT JOIN LATERAL (
            SELECT array_agg(p.full_name) AS speaker_names
            FROM event_speakers es JOIN people p ON p.id = es.person_id
            WHERE es.event_id = e.id
        ) es ON TRUE
        LEFT JOIN LATERAL (
            SELECT array_agg(p.full_name) AS artist_names
            FROM event_artists ea JOIN people p ON p.id = ea.person_id
            WHERE ea.event_id = e.id
        ) ea ON TRUE
        LEFT JOIN LATERAL (
            SELECT array_agg(p.full_name) AS performer_names
            FROM event_performers ep JOIN people p ON p.id = ep.person_id
            WHERE ep.event_id = e.id
        ) ep ON TRUE
        LEFT JOIN LATERAL (
            SELECT array_agg(t.slug) AS topic_slugs
            FROM event_topics et JOIN topics t ON t.id = et.topic_id
            WHERE et.event_id = e.id
        ) et ON TRUE
        WHERE e.id = ${id}
        LIMIT 1
    `;
    if (rows.length === 0) {
        return jsonSafe(c,{ ok: false, error: "not-found" }, 404);
    }
    return jsonSafe(c,{ ok: true, event: rows[0] });
});

// ── list enabled event sources ──────────────────────────────────────
upcomingEventsRoute.get("/event-sources", async (c) => {
    const rows = await sql<Record<string, unknown>[]>`
        SELECT id, source, name, host, country_code, region, city,
               default_category, source_priority, politeness_tier,
               is_active, last_fetched_at, last_status,
               items_last_fetch, consecutive_failures,
               notes
        FROM event_sources
        ORDER BY source_priority ASC, id ASC
    `;
    return jsonSafe(c,{ ok: true, count: rows.length, sources: rows });
});

// ── submit a new event ──────────────────────────────────────────────
upcomingEventsRoute.post("/event-submissions", async (c) => {
    let body: Record<string, unknown>;
    try {
        body = await c.req.json();
    } catch {
        return jsonSafe(c,{ ok: false, error: "invalid json" }, 400);
    }
    const required = ["submitter_email", "title", "starts_at"];
    for (const k of required) {
        if (!body[k]) {
            return jsonSafe(c,{ ok: false, error: `missing ${k}` }, 400);
        }
    }
    const rows = await sql<Record<string, unknown>[]>`
        INSERT INTO event_submissions (
            submitter_email, submitter_name, title, description,
            category, venue_name, venue_address, city, region, country,
            lat, lng, starts_at, ends_at, is_online, is_free, url, image_url
        ) VALUES (
            ${String(body.submitter_email)},
            ${body.submitter_name ? String(body.submitter_name) : null},
            ${String(body.title)},
            ${body.description ? String(body.description) : null},
            ${body.category ? String(body.category) : "community"},
            ${body.venue_name ? String(body.venue_name) : null},
            ${body.venue_address ? String(body.venue_address) : null},
            ${body.city ? String(body.city) : null},
            ${body.region ? String(body.region) : null},
            ${body.country ? String(body.country) : null},
            ${body.lat != null ? Number(body.lat) : null},
            ${body.lng != null ? Number(body.lng) : null},
            ${String(body.starts_at)},
            ${body.ends_at ? String(body.ends_at) : null},
            ${body.is_online === true},
            ${body.is_free === true ? true : body.is_free === false ? false : null},
            ${body.url ? String(body.url) : null},
            ${body.image_url ? String(body.image_url) : null}
        )
        RETURNING id, status, submitted_at
    `;
    return jsonSafe(c,{ ok: true, submission: rows[0] }, 201);
});

// ── list my submissions ─────────────────────────────────────────────
upcomingEventsRoute.get("/event-submissions/mine", async (c) => {
    const email = c.req.query("email");
    if (!email) {
        return jsonSafe(c,{ ok: false, error: "email required" }, 400);
    }
    const rows = await sql<Record<string, unknown>[]>`
        SELECT id, title, description, category, city, country,
               starts_at, ends_at, url, status, submitted_at, reviewed_at,
               reviewer_notes
        FROM event_submissions
        WHERE submitter_email = ${email}
        ORDER BY submitted_at DESC
        LIMIT 100
    `;
    return jsonSafe(c,{ ok: true, count: rows.length, submissions: rows });
});

// ── save a search ───────────────────────────────────────────────────
upcomingEventsRoute.post("/searches/save", async (c) => {
    let body: Record<string, unknown>;
    try {
        body = await c.req.json();
    } catch {
        return jsonSafe(c,{ ok: false, error: "invalid json" }, 400);
    }
    if (!body.user_token || !body.query) {
        return jsonSafe(c,{ ok: false, error: "user_token and query required" },
            400);
    }
    const kind = String(body.kind ?? "news");
    const rows = await sql<Record<string, unknown>[]>`
        INSERT INTO saved_searches (
            user_token, kind, query, filters, label, result_count
        ) VALUES (
            ${String(body.user_token)},
            ${kind},
            ${String(body.query)},
            ${JSON.stringify(body.filters ?? {})}::jsonb,
            ${body.label ? String(body.label) : null},
            ${body.result_count != null ? Number(body.result_count) : null}
        )
        RETURNING id, saved_at
    `;
    // Bump aggregate table (best effort — separate UPSERT)
    await sql`
        INSERT INTO search_query_stats (query, kind, use_count, last_used_at)
        VALUES (${String(body.query)}, ${kind}, 1, now())
        ON CONFLICT (query) DO UPDATE SET
            use_count   = search_query_stats.use_count + 1,
            last_used_at = now()
    `;
    return jsonSafe(c,{ ok: true, saved: rows[0] }, 201);
});

// ── list my saved searches ──────────────────────────────────────────
upcomingEventsRoute.get("/searches/saved", async (c) => {
    const token = c.req.query("user_token");
    if (!token) {
        return jsonSafe(c,{ ok: false, error: "user_token required" }, 400);
    }
    const kind = c.req.query("kind");
    const rows = await sql<Record<string, unknown>[]>`
        SELECT id, kind, query, filters, label, result_count, click_count,
               saved_at, last_used_at
        FROM saved_searches
        WHERE user_token = ${token}
          ${kind ? sql`AND kind = ${kind}` : sql``}
        ORDER BY last_used_at DESC
        LIMIT 200
    `;
    return jsonSafe(c,{ ok: true, count: rows.length, searches: rows });
});
