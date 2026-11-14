import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb } from "../db";
import { RateLimiter, getClientIp } from "../ratelimit";
import { enqueueOrSpawn } from "../queue/enqueueOrSpawn";
import { adminAuth } from "../auth";

// Response size caps (Tier response-size-caps, Audit 4):
// - /api/analytics/visitors/countries: capped at 300 (country vocabulary
//   is bounded, but the COALESCE() expression can collapse unusual
//   detected_country strings into many rows). Response now includes
//   `capped: boolean`.
//
// Note: every other /api/analytics/* list endpoint was already capped:
//   - /api/analytics/rankings/sources   : Math.min(..., 200)
//   - /api/analytics/heatmap            : Math.min(..., 2000)
//   - /api/analytics/trending           : Math.min(..., 50)
//   - /api/analytics/reported-articles  : Math.min(..., 200)
//   - /api/analytics/client-errors      : Math.min(..., 500)
//   - /api/analytics/interactions       : zod .max(500)
//   - /api/analytics/problems           : zod .max(200)
//   - /api/analytics/visitors/cities    : hard LIMIT 50
//   - /api/analytics/visitors/recent    : Math.min(..., 200)
//   - /api/analytics/reports/:articleId : hard LIMIT 20

export const analyticsRoute = new Hono();

// ISO-3166 alpha-2 → full country name. The map data + RSS feeds store
// 2-letter codes (cheap, stable), but humans read "United States" not
// "US". The frontend pairs this with REGION_FOR_COUNTRY to render a
// City / Region / Country column on the help page.
const COUNTRY_NAMES: Record<string, string> = {
  US: "United States", CA: "Canada", MX: "Mexico", BR: "Brazil", AR: "Argentina",
  CL: "Chile", CO: "Colombia", PE: "Peru", VE: "Venezuela", UY: "Uruguay",
  PY: "Paraguay", BO: "Bolivia", EC: "Ecuador", CR: "Costa Rica", PA: "Panama",
  GT: "Guatemala", HN: "Honduras", SV: "El Salvador", NI: "Nicaragua", CU: "Cuba",
  DO: "Dominican Republic", PR: "Puerto Rico", JM: "Jamaica", HT: "Haiti", TT: "Trinidad and Tobago",
  GB: "United Kingdom", IE: "Ireland", FR: "France", DE: "Germany", ES: "Spain",
  PT: "Portugal", IT: "Italy", NL: "Netherlands", BE: "Belgium", LU: "Luxembourg",
  CH: "Switzerland", AT: "Austria", DK: "Denmark", SE: "Sweden", NO: "Norway",
  FI: "Finland", IS: "Iceland", PL: "Poland", CZ: "Czechia", SK: "Slovakia",
  HU: "Hungary", RO: "Romania", BG: "Bulgaria", GR: "Greece", HR: "Croatia",
  SI: "Slovenia", RS: "Serbia", BA: "Bosnia and Herzegovina", AL: "Albania",
  MK: "North Macedonia", ME: "Montenegro", XK: "Kosovo", MD: "Moldova", UA: "Ukraine",
  BY: "Belarus", LT: "Lithuania", LV: "Latvia", EE: "Estonia", RU: "Russia",
  TR: "Turkey", CY: "Cyprus", IL: "Israel", LB: "Lebanon", SY: "Syria",
  JO: "Jordan", IQ: "Iraq", IR: "Iran", SA: "Saudi Arabia", AE: "United Arab Emirates",
  QA: "Qatar", BH: "Bahrain", KW: "Kuwait", OM: "Oman", YE: "Yemen",
  EG: "Egypt", LY: "Libya", TN: "Tunisia", DZ: "Algeria", MA: "Morocco",
  SD: "Sudan", ET: "Ethiopia", KE: "Kenya", UG: "Uganda", TZ: "Tanzania",
  ZA: "South Africa", NG: "Nigeria", GH: "Ghana", SN: "Senegal", CI: "Côte d'Ivoire",
  AO: "Angola", MZ: "Mozambique", ZM: "Zambia", ZW: "Zimbabwe", RW: "Rwanda",
  IN: "India", PK: "Pakistan", BD: "Bangladesh", LK: "Sri Lanka", NP: "Nepal",
  BT: "Bhutan", MV: "Maldives", AF: "Afghanistan", CN: "China", HK: "Hong Kong",
  MO: "Macao", TW: "Taiwan", JP: "Japan", KR: "South Korea", KP: "North Korea",
  MN: "Mongolia", VN: "Vietnam", TH: "Thailand", MM: "Myanmar", LA: "Laos",
  KH: "Cambodia", MY: "Malaysia", SG: "Singapore", ID: "Indonesia", PH: "Philippines",
  BN: "Brunei", TL: "Timor-Leste", AU: "Australia", NZ: "New Zealand", FJ: "Fiji",
  PG: "Papua New Guinea", WS: "Samoa", TO: "Tonga", VU: "Vanuatu", SB: "Solomon Islands",
};

// Region grouping for the city/country display. Coarse by design — the
// goal is "North America / Western Europe / East Asia" buckets, not a
// perfect mirror of the UN geoscheme.
const REGION_FOR_COUNTRY: Record<string, string> = {
  // North America
  US: "North America", CA: "North America", MX: "North America",
  // Central America & Caribbean
  GT: "Central America", HN: "Central America", SV: "Central America",
  NI: "Central America", CR: "Central America", PA: "Central America",
  BZ: "Central America", CU: "Caribbean", DO: "Caribbean", PR: "Caribbean",
  JM: "Caribbean", HT: "Caribbean", TT: "Caribbean", BB: "Caribbean", BS: "Caribbean",
  // South America
  BR: "South America", AR: "South America", CL: "South America", CO: "South America",
  PE: "South America", VE: "South America", UY: "South America", PY: "South America",
  BO: "South America", EC: "South America", GY: "South America", SR: "South America",
  GF: "South America",
  // Western Europe
  GB: "Western Europe", IE: "Western Europe", FR: "Western Europe", DE: "Western Europe",
  ES: "Western Europe", PT: "Western Europe", IT: "Western Europe", NL: "Western Europe",
  BE: "Western Europe", LU: "Western Europe", CH: "Western Europe", AT: "Western Europe",
  // Northern Europe
  DK: "Northern Europe", SE: "Northern Europe", NO: "Northern Europe", FI: "Northern Europe",
  IS: "Northern Europe", EE: "Northern Europe", LV: "Northern Europe", LT: "Northern Europe",
  // Eastern Europe
  PL: "Eastern Europe", CZ: "Eastern Europe", SK: "Eastern Europe", HU: "Eastern Europe",
  RO: "Eastern Europe", BG: "Eastern Europe", MD: "Eastern Europe", UA: "Eastern Europe",
  BY: "Eastern Europe", RU: "Eastern Europe",
  // Southern Europe / Balkans
  GR: "Southern Europe", HR: "Southern Europe", SI: "Southern Europe", RS: "Southern Europe",
  BA: "Southern Europe", AL: "Southern Europe", MK: "Southern Europe", ME: "Southern Europe",
  XK: "Southern Europe", CY: "Southern Europe", TR: "Southern Europe", MT: "Southern Europe",
  // Middle East
  IL: "Middle East", LB: "Middle East", SY: "Middle East", JO: "Middle East",
  IQ: "Middle East", IR: "Middle East", SA: "Middle East", AE: "Middle East",
  QA: "Middle East", BH: "Middle East", KW: "Middle East", OM: "Middle East", YE: "Middle East",
  // North Africa
  EG: "North Africa", LY: "North Africa", TN: "North Africa", DZ: "North Africa",
  MA: "North Africa", SD: "North Africa",
  // Sub-Saharan Africa
  ET: "Sub-Saharan Africa", KE: "Sub-Saharan Africa", UG: "Sub-Saharan Africa",
  TZ: "Sub-Saharan Africa", ZA: "Sub-Saharan Africa", NG: "Sub-Saharan Africa",
  GH: "Sub-Saharan Africa", SN: "Sub-Saharan Africa", CI: "Sub-Saharan Africa",
  AO: "Sub-Saharan Africa", MZ: "Sub-Saharan Africa", ZM: "Sub-Saharan Africa",
  ZW: "Sub-Saharan Africa", RW: "Sub-Saharan Africa", CM: "Sub-Saharan Africa",
  // South Asia
  IN: "South Asia", PK: "South Asia", BD: "South Asia", LK: "South Asia",
  NP: "South Asia", BT: "South Asia", MV: "South Asia", AF: "South Asia",
  // East Asia
  CN: "East Asia", HK: "East Asia", MO: "East Asia", TW: "East Asia",
  JP: "East Asia", KR: "East Asia", KP: "East Asia", MN: "East Asia",
  // Southeast Asia
  VN: "Southeast Asia", TH: "Southeast Asia", MM: "Southeast Asia", LA: "Southeast Asia",
  KH: "Southeast Asia", MY: "Southeast Asia", SG: "Southeast Asia", ID: "Southeast Asia",
  PH: "Southeast Asia", BN: "Southeast Asia", TL: "Southeast Asia",
  // Oceania
  AU: "Oceania", NZ: "Oceania", FJ: "Oceania", PG: "Oceania", WS: "Oceania",
  TO: "Oceania", VU: "Oceania", SB: "Oceania",
};

// Rate limiter for interaction logging (generous - 100 per minute)
const logLimiter = new RateLimiter({ max: 100, windowMs: 60 * 1000 });

// ── POST /api/analytics/log ────────────────────────────────────────────
//
// Log a user interaction. Called from the frontend on meaningful actions.
const InteractionSchema = z.object({
  session_id: z.string().min(1).max(100),
  type: z.enum([
    'pin_click', 'pin_view', 'source_click', 'map_move',
    'search', 'fix_location', 'vote', 'explore_region',
    'set_home', 'page_view',
    'ui_click', 'performance',
  ]),
  pin_id: z.number().optional(),
  article_id: z.number().optional(),
  source_id: z.number().optional(),
  event_id: z.number().optional(),
  map_lat: z.number().optional(),
  map_lng: z.number().optional(),
  map_zoom: z.number().optional(),
  bbox: z.string().optional(),
  metadata: z.any().optional(),
});

// ── POST /api/analytics/presence ────────────────────────────────────
// Lightweight endpoint to track user presence (active vs idle).
// When user is active, workers should throttle. When idle, workers can run freely.
// No database write — just an in-memory flag for the worker pool.
const _userPresence = new Map<string, { active: boolean; timestamp: number }>();

analyticsRoute.post("/analytics/presence", async (c) => {
  try {
    const body = await c.req.json();
    const ip = getClientIp(c.req.raw);
    _userPresence.set(ip, {
      active: body.active !== false,
      timestamp: Date.now(),
    });
  } catch (_) {}
  return c.json({ ok: true });
});

// Export for worker pool to check — returns true if ANY user is active
export function isUserActive(): boolean {
  const now = Date.now();
  for (const [, presence] of _userPresence) {
    if (presence.active && (now - presence.timestamp) < 60_000) {
      return true;
    }
  }
  return false;
}

analyticsRoute.post(
  "/analytics/log",
  zValidator("json", InteractionSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = logLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited" }, 429);
    }

    const data = c.req.valid("json");
    const sql = getDb();
    // Tier 1.2: client-generated UUID in X-Idempotency-Key dedups via
    // partial UNIQUE index. NULL values are excluded by the index, so
    // legacy callers that don't send the header continue to work (each
    // insert has NULL idempotency_key and doesn't conflict).
    //
    // Tier 1.2 hardening: prefix the stored key with session_id so two
    // different sessions can't collide on the same UUID, and an attacker
    // who can guess a client key still can't claim another session's
    // slot (they'd need the session_id to forge the composite key).
    const rawKey = c.req.header("X-Idempotency-Key") || null;
    const idempotencyKey = rawKey ? `${data.session_id}:${rawKey}` : null;

    // Get user's detected location from IP
    let userCountry: string | null = null;
    let userCity: string | null = null;
    let userLat: number | null = null;
    let userLng: number | null = null;

    // Try to get from user_locations table first
    const existingUser = await sql<any[]>`
      SELECT active_lat, active_lng, home_country, detected_country
      FROM news_user_locations
      WHERE session_id = ${data.session_id}
      LIMIT 1
    `;

    if (existingUser[0]) {
      userLat = existingUser[0].active_lat;
      userLng = existingUser[0].active_lng;
      userCountry = existingUser[0].home_country || existingUser[0].detected_country;
    }

    const ipAddress = ip !== 'unknown' ? ip : null;

    // Insert the interaction. ON CONFLICT (idempotency_key) DO NOTHING
    // makes retries (network blips, double-clicks) idempotent instead
    // of corrupting interactions_24h + source rankings + coverage stats.
    //
    // Foreign key validation: if pin_id/article_id/source_id/event_id
    // don't exist in their respective tables, set them to NULL instead
    // of failing the insert. This handles race conditions where the
    // frontend logs an interaction for a pin that was just deleted.
    const pinId = data.pin_id || null;
    const articleId = data.article_id || null;
    const sourceId = data.source_id || null;
    const eventId = data.event_id || null;

    // Q3 (README): resolve the article id exactly as /analytics/batch
    // does — an explicit article_id first, then the client's pin_id when
    // it is really a news_articles.id (for RSS/editorial pins
    // /api/pins/map's `id` IS the article id, and it has always arrived
    // labelled pin_id). Guarded on an id being present at all: every
    // event this endpoint records today is a `performance` mark carrying
    // no ids, so the common path runs no extra query.
    let resolvedArticleId: number | null = articleId ?? null;
    if (resolvedArticleId == null && pinId != null) {
      const hit = await sql<any[]>`
        SELECT id FROM news_articles
         WHERE id = ${pinId}
           AND NOT EXISTS (SELECT 1 FROM pins WHERE id = ${pinId})
         LIMIT 1`;
      resolvedArticleId = hit.length ? Number(hit[0].id) : null;
    }

    const inserted = await sql<any[]>`
      INSERT INTO news_interactions (
        session_id, interaction_type,
        pin_id, article_id, source_id, event_id,
        map_lat, map_lng, map_zoom, bbox,
        user_lat, user_lng, user_country, user_city,
        ip_address, metadata,
        idempotency_key
      ) VALUES (
        ${data.session_id}, ${data.type},
        CASE WHEN ${pinId}::bigint IS NOT NULL AND EXISTS (SELECT 1 FROM pins WHERE id = ${pinId}::bigint) THEN ${pinId}::bigint ELSE NULL END,
        CASE WHEN ${resolvedArticleId}::bigint IS NOT NULL AND EXISTS (SELECT 1 FROM news_articles WHERE id = ${resolvedArticleId}::bigint) THEN ${resolvedArticleId}::bigint ELSE NULL END,
        CASE WHEN ${sourceId}::bigint IS NOT NULL AND EXISTS (SELECT 1 FROM news_sources WHERE id = ${sourceId}::bigint) THEN ${sourceId}::bigint
             -- Q3 (README): the client cannot send an honest source_id —
             -- a map pin is a CLUSTER of articles from several sources —
             -- so the server derives it from the resolved article. Doing
             -- it here also means a caller that lies about source_id
             -- cannot inject attribution it does not own.
             ELSE (SELECT a.source_id FROM news_articles a
                    WHERE a.id = ${resolvedArticleId}::bigint
                      AND a.source_id IS NOT NULL) END,
        CASE WHEN ${eventId}::bigint IS NOT NULL AND EXISTS (SELECT 1 FROM news_events WHERE id = ${eventId}::bigint) THEN ${eventId}::bigint ELSE NULL END,
        ${data.map_lat || null}, ${data.map_lng || null},
        ${data.map_zoom != null ? Math.round(data.map_zoom) : null}, ${data.bbox || null},
        ${userLat}, ${userLng}, ${userCountry}, ${userCity},
        ${ipAddress}::inet,
        ${data.metadata ? JSON.stringify(data.metadata) : null}::jsonb,
        ${idempotencyKey}
      )
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING id
    `;

    if (inserted.length === 0 && idempotencyKey) {
      // Duplicate — already inserted by a previous retry. Acknowledge
      // so the client knows the request was a no-op (not a fresh hit).
      return c.json({ ok: true, duplicate: true });
    }

    return c.json({ ok: true });
  }
);

// ── POST /api/analytics/batch ──────────────────────────────────────────
//
// Log multiple interactions at once (for batching on frontend)
const BatchSchema = z.object({
  session_id: z.string().min(1).max(100),
  events: z.array(InteractionSchema.omit({ session_id: true })).max(50),
});

analyticsRoute.post(
  "/analytics/batch",
  zValidator("json", BatchSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = logLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited" }, 429);
    }

    const { session_id, events } = c.req.valid("json");
    const sql = getDb();
    // Tier 1.2: read header once, derive a per-event key by appending
    // the event's position in the batch. Retries of the whole batch →
    // every per-event key collides → 0 inserts (good). Retry of a
    // partial set (e.g. client truncates after index 12) → only those
    // conflict, the rest insert fresh (also good). NULL header (legacy)
    // → all events get NULL idempotency_key → no dedup, but also no
    // conflict since NULLs are excluded by the partial unique index.
    //
    // Tier 1.2 hardening: prefix the stored key with session_id so two
    // different sessions can't collide on the same UUID, and an attacker
    // who can guess a client key still can't claim another session's
    // slot (they'd need the session_id to forge the composite key).
    // Per-event derivation `${headerKey}:${i}` cascades naturally into
    // `${session_id}:${rawKey}:${i}`.
    const rawHeaderKey = c.req.header("X-Idempotency-Key") || null;
    const headerKey = rawHeaderKey ? `${session_id}:${rawHeaderKey}` : null;

    // Get user location once
    const existingUser = await sql<any[]>`
      SELECT active_lat, active_lng, home_country
      FROM news_user_locations
      WHERE session_id = ${session_id}
      LIMIT 1
    `;

    const userLat = existingUser[0]?.active_lat || null;
    const userLng = existingUser[0]?.active_lng || null;
    const userCountry = existingUser[0]?.home_country || null;
    const ipAddress = ip !== 'unknown' ? ip : null;

    // Tier 3 quick win: collapse N round-trips into ONE multi-row
    // INSERT via unnest(...). Returns only the rows that actually
    // inserted (ON CONFLICT filters duplicates silently). We pass
    // empty arrays when there are no events so the query shape stays
    // stable and postgres.js doesn't error on the unnest() call.
    const types = events.map((e) => e.type);
    const pinIds = events.map((e) => e.pin_id ?? null);
    const articleIds = events.map((e) => e.article_id ?? null);
    const sourceIds = events.map((e) => e.source_id ?? null);
    const eventIds = events.map((e) => e.event_id ?? null);
    const lats = events.map((e) => e.map_lat ?? null);
    const lngs = events.map((e) => e.map_lng ?? null);
    const zooms = events.map((e) => (e.map_zoom != null ? Math.round(e.map_zoom) : null));
    const bboxes = events.map((e) => e.bbox ?? null);
    const metas = events.map((e) =>
      e.metadata ? JSON.stringify(e.metadata) : null,
    );
    const keys = events.map((_, i) => (headerKey ? `${headerKey}:${i}` : null));

    const inserted = await sql<any[]>`
      INSERT INTO news_interactions (
        session_id, interaction_type,
        pin_id, article_id, source_id, event_id,
        map_lat, map_lng, map_zoom, bbox,
        user_lat, user_lng, user_country,
        ip_address, metadata,
        idempotency_key
      )
      SELECT
        ${session_id}::text,
        t.type,
        CASE WHEN t.pin_id IS NOT NULL AND EXISTS (SELECT 1 FROM pins WHERE id = t.pin_id) THEN t.pin_id ELSE NULL END,
        r.article_id,
        CASE WHEN t.source_id IS NOT NULL AND EXISTS (SELECT 1 FROM news_sources WHERE id = t.source_id) THEN t.source_id
             ELSE (SELECT a.source_id FROM news_articles a
                    WHERE a.id = r.article_id AND a.source_id IS NOT NULL)
        END,
        CASE WHEN t.event_id IS NOT NULL AND EXISTS (SELECT 1 FROM news_events WHERE id = t.event_id) THEN t.event_id ELSE NULL END,
        t.lat, t.lng, t.zoom, t.bbox,
        ${userLat}::double precision, ${userLng}::double precision, ${userCountry}::text,
        ${ipAddress}::inet,
        t.meta::jsonb,
        t.key
      FROM unnest(
        ${types}::text[],
        ${pinIds}::bigint[],
        ${articleIds}::bigint[],
        ${sourceIds}::bigint[],
        ${eventIds}::bigint[],
        ${lats}::double precision[],
        ${lngs}::double precision[],
        ${zooms}::int[],
        ${bboxes}::text[],
        ${metas}::text[],
        ${keys}::text[]
      ) AS t(type, pin_id, article_id, source_id, event_id,
             lat, lng, zoom, bbox, meta, key)
      -- Q3 (README): resolve ONE article id per event, and do it here
      -- rather than in the client.
      --
      -- The client cannot honestly send source_id: a map pin is a
      -- CLUSTER of articles from several sources, so there is no single
      -- value for it to invent — that is why source_id had been NULL on
      -- every interaction since 2026-09-04 and news_source_rankings had
      -- been frozen since 10-04. The article, by contrast, has exactly
      -- one source, so resolving the article is enough.
      --
      -- Two ways to arrive at it, in priority order:
      --   1. an explicit article_id (analytics.js and anything built
      --      later can send one; /api/pins/map now returns it);
      --   2. the id the client DID send as pin_id — for RSS/editorial
      --      pins /api/pins/map's id IS a news_articles.id, not a
      --      pins.id, and analytics.js has always passed it as pin_id.
      --      Inferred only when pin_id is NOT a real pins row, so a
      --      genuine community pin can never be mistaken for an article.
      -- Every guard is an EXISTS, so a bad id degrades to NULL instead
      -- of failing the insert — and because the source is looked up
      -- from the resolved article, a caller that lies about source_id
      -- cannot inject attribution it does not own.
      LEFT JOIN LATERAL (
        SELECT CASE
          WHEN t.article_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM news_articles a WHERE a.id = t.article_id)
               THEN t.article_id
          WHEN t.pin_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM pins p WHERE p.id = t.pin_id)
               AND EXISTS (SELECT 1 FROM news_articles a WHERE a.id = t.pin_id)
               THEN t.pin_id
          ELSE NULL
        END AS article_id
      ) r ON TRUE
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING id
    `;

    const insertedCount = inserted.length;
    const duplicates = headerKey ? events.length - insertedCount : 0;
    return c.json({
      ok: true,
      count: events.length,
      inserted: insertedCount,
      duplicates,
    });
  }
);

// ── POST /api/analytics/set-home ───────────────────────────────────────
//
// Set user's home location.  When source='detected' the row is written
// to detected_* columns (IP geolocation guess) so the operator dashboard
// can distinguish explicit user-set homes from passive IP detection.
const SetHomeSchema = z.object({
  session_id: z.string().min(1).max(100),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  city: z.string().max(200).optional(),
  country: z.string().max(2).optional(),
  source: z.enum(["home", "detected"]).optional().default("home"),
});

analyticsRoute.post(
  "/analytics/set-home",
  zValidator("json", SetHomeSchema),
  async (c) => {
    const data = c.req.valid("json");
    const sql = getDb();
    const rawKey = c.req.header("X-Idempotency-Key") || null;
    const idempotencyKey = rawKey ? `${data.session_id}:${rawKey}` : null;
    const isDetected = data.source === "detected";

    if (isDetected) {
      // Detected via IP geolocation — write to detected_* columns only.
      // Never overwrite an explicit home_* that the user set.
      await sql`
        INSERT INTO news_user_locations (
          session_id, detected_lat, detected_lng, detected_city, detected_country,
          detected_at, active_lat, active_lng, active_source, last_seen_at
        ) VALUES (
          ${data.session_id}, ${data.lat}, ${data.lng},
          ${data.city || null}, ${data.country || null},
          now(), ${data.lat}, ${data.lng}, 'detected', now()
        )
        ON CONFLICT (session_id) DO UPDATE SET
          detected_lat = ${data.lat},
          detected_lng = ${data.lng},
          detected_city = ${data.city || null},
          detected_country = ${data.country || null},
          detected_at = now(),
          active_lat = CASE WHEN news_user_locations.active_source = 'home'
                            THEN news_user_locations.active_lat ELSE ${data.lat} END,
          active_lng = CASE WHEN news_user_locations.active_source = 'home'
                            THEN news_user_locations.active_lng ELSE ${data.lng} END,
          active_source = CASE WHEN news_user_locations.home_lat IS NOT NULL
                               THEN 'home' ELSE 'detected' END,
          last_seen_at = now()
      `;
    } else {
      // Explicit user-set home — write to home_* columns.
      await sql`
        INSERT INTO news_user_locations (
          session_id, home_lat, home_lng, home_city, home_country,
          home_set_at, active_lat, active_lng, active_source, last_seen_at
        ) VALUES (
          ${data.session_id}, ${data.lat}, ${data.lng},
          ${data.city || null}, ${data.country || null},
          now(), ${data.lat}, ${data.lng}, 'home', now()
        )
        ON CONFLICT (session_id) DO UPDATE SET
          home_lat = ${data.lat},
          home_lng = ${data.lng},
          home_city = ${data.city || null},
          home_country = ${data.country || null},
          home_set_at = now(),
          active_lat = ${data.lat},
          active_lng = ${data.lng},
          active_source = 'home',
          last_seen_at = now()
      `;
    }

    // Also log the interaction (dedup via partial unique index).
    const interaction = await sql<any[]>`
      INSERT INTO news_interactions (
        session_id, interaction_type, user_lat, user_lng, user_country,
        idempotency_key
      ) VALUES (
        ${data.session_id}, 'set_home', ${data.lat}, ${data.lng},
        ${data.country || null},
        ${idempotencyKey}
      )
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING id
    `;

    if (interaction.length === 0 && idempotencyKey) {
      return c.json({ ok: true, duplicate: true });
    }

    return c.json({ ok: true });
  }
);

// ── GET /api/analytics/rankings/sources ─────────────────────────────────
//
// Get source rankings leaderboard. Gated ["super"]: the leaderboard
// exposes per-source engagement signals (clicks_7d, users_7d) that
// give operators a competitive read; not safe to expose to the world.
analyticsRoute.get("/analytics/rankings/sources", async (c) => {
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;

  const limit = Math.min(Number(c.req.query("limit") || 50), 200);
  const region = c.req.query("region");
  const country = c.req.query("country");

  const sql = getDb();

  let query = sql`
    SELECT
      ns.id, ns.name, ns.country, ns.region,
      COALESCE(sr.overall_score, 0) as score,
      COALESCE(sr.clicks_7d, 0) as clicks_7d,
      COALESCE(sr.views_7d, 0) as views_7d,
      COALESCE(sr.unique_users_7d, 0) as users_7d,
      COALESCE(sr.countries_reached, 0) as countries,
      (SELECT COUNT(*) FROM news_articles na WHERE na.source_id = ns.id) as articles
    FROM news_sources ns
    LEFT JOIN news_source_rankings sr ON sr.source_id = ns.id
    WHERE ns.active = TRUE
  `;

  if (region) {
    query = sql`${query} AND ns.region ILIKE ${'%' + region + '%'}`;
  }
  if (country) {
    query = sql`${query} AND ns.country = ${country.toUpperCase()}`;
  }

  query = sql`${query} ORDER BY score DESC, articles DESC LIMIT ${limit}`;

  const rows = await query;

  return c.json({
    rankings: rows.map((r, i) => ({
      rank: i + 1,
      source_id: Number(r.id),
      name: r.name,
      country: r.country,
      region: r.region,
      score: Number(r.score),
      clicks_7d: Number(r.clicks_7d),
      views_7d: Number(r.views_7d),
      users_7d: Number(r.users_7d),
      countries: Number(r.countries),
      articles: Number(r.articles),
    })),
    total: rows.length,
  });
});

// ── GET /api/analytics/dashboard ────────────────────────────────────
// Public aggregated endpoint for the help page overview + sources tabs.
// Returns source rankings, visitor cities, and recent search queries —
// all pre-aggregated, no PII (no session_id, no raw coordinates).
// This avoids the adminAuth gate on /analytics/rankings/sources,
// /analytics/visitors/cities, and /analytics/interactions which the
// help page cannot authenticate against.
analyticsRoute.get("/analytics/dashboard", async (c) => {
  const sql = getDb();
  const region = c.req.query("region");

  const [rankings, cities, searches] = await Promise.all([
    // Source rankings (score, name, country, region, article count).
    // When a region filter is applied, return ALL matching sources (no LIMIT)
    // so the filter works even when top-scoring sources are in other regions.
    region && region !== 'all'
      ? sql<any[]>`
          SELECT ns.name, ns.country, ns.region,
                 COALESCE(sr.overall_score, 0) as score,
                 (SELECT COUNT(*) FROM news_articles na WHERE na.source_id = ns.id) as articles
          FROM news_sources ns
          LEFT JOIN news_source_rankings sr ON sr.source_id = ns.id
          WHERE ns.active = TRUE
            AND LOWER(ns.region) LIKE ${'%' + region.toLowerCase() + '%'}
          ORDER BY score DESC, articles DESC
        `
      : sql<any[]>`
          SELECT ns.name, ns.country, ns.region,
                 COALESCE(sr.overall_score, 0) as score,
                 (SELECT COUNT(*) FROM news_articles na WHERE na.source_id = ns.id) as articles
          FROM news_sources ns
          LEFT JOIN news_source_rankings sr ON sr.source_id = ns.id
          WHERE ns.active = TRUE
          ORDER BY score DESC, articles DESC
          LIMIT 50
        `,
    // Top visitor cities (aggregated, no session_id). Includes lat/lng
    // so the frontend can plot them on a map.
    sql<any[]>`
      SELECT COALESCE(detected_city, home_city, 'Unknown') as city,
             COALESCE(detected_country, home_country, '?') as country,
             COUNT(DISTINCT session_id) as visits,
             MAX(last_seen_at) as last_seen,
             AVG(COALESCE(detected_lat, home_lat)) as lat,
             AVG(COALESCE(detected_lng, home_lng)) as lng
      FROM news_user_locations
      WHERE COALESCE(detected_city, home_city) IS NOT NULL
        AND COALESCE(detected_lat, home_lat) IS NOT NULL
      GROUP BY COALESCE(detected_city, home_city, 'Unknown'),
               COALESCE(detected_country, home_country, '?')
      ORDER BY visits DESC
      LIMIT 50
    `,
    // Recent search queries (no session_id, no user_city/country)
    sql<any[]>`
      SELECT interaction_type, metadata, created_at
      FROM news_interactions
      WHERE created_at >= now() - interval '24 hours'
        AND interaction_type = 'search'
      ORDER BY created_at DESC
      LIMIT 20
    `,
  ]);

  return c.json({
    rankings: rankings.map((r, i) => ({
      rank: i + 1,
      name: r.name,
      country: r.country,
      region: r.region || null,
      score: Number(r.score),
      articles: Number(r.articles),
    })),
    cities: cities.map((r) => ({
      city: r.city,
      country: r.country,
      visits: Number(r.visits),
      last_seen: r.last_seen,
      lat: r.lat != null ? Number(r.lat) : null,
      lng: r.lng != null ? Number(r.lng) : null,
    })),
    searches: searches.map((r) => ({
      query: r.metadata?.query || null,
      result_count: r.metadata?.result_count ?? null,
      created_at: r.created_at,
    })),
  });
});

// ── GET /api/analytics/heatmap ──────────────────────────────────────────
//
// Get geographic interest heatmap data
analyticsRoute.get("/analytics/heatmap", async (c) => {
  const hours = Math.min(Number(c.req.query("hours") || 24), 168);
  const limit = Math.min(Number(c.req.query("limit") || 500), 2000);

  const sql = getDb();

  const rows = await sql<any[]>`
    SELECT
      grid_lat,
      grid_lng,
      SUM(click_count) as clicks,
      SUM(view_count) as views,
      SUM(search_count) as searches,
      SUM(unique_users) as users,
      SUM(interest_score) as score
    FROM news_geo_interest
    WHERE window_start > now() - ${hours + ' hours'}::interval
    GROUP BY grid_lat, grid_lng
    ORDER BY score DESC
    LIMIT ${limit}
  `;

  return c.json({
    heatmap: rows.map(r => ({
      lat: Number(r.grid_lat),
      lng: Number(r.grid_lng),
      clicks: Number(r.clicks),
      views: Number(r.views),
      searches: Number(r.searches),
      users: Number(r.users),
      score: Number(r.score),
    })),
    window_hours: hours,
  });
});

// ── GET /api/analytics/trending ─────────────────────────────────────────
//
// Get trending topics by region
analyticsRoute.get("/analytics/trending", async (c) => {
  const region = c.req.query("region") || "global";
  const hours = Math.min(Number(c.req.query("hours") || 24), 168);
  const limit = Math.min(Number(c.req.query("limit") || 20), 50);

  const sql = getDb();

  // Get trending from recent interactions + article counts
  const rows = await sql<any[]>`
    SELECT
      a.event_type as topic,
      COUNT(DISTINCT a.id) as article_count,
      COUNT(DISTINCT ni.session_id) as engaged_users,
      COUNT(ni.id) FILTER (WHERE ni.interaction_type = 'pin_click') as clicks
    FROM news_articles a
    LEFT JOIN news_interactions ni ON ni.article_id = a.id
      AND ni.created_at > now() - ${hours + ' hours'}::interval
    WHERE a.fetched_at > now() - ${hours + ' hours'}::interval
      AND a.event_type IS NOT NULL
    GROUP BY a.event_type
    ORDER BY article_count DESC, engaged_users DESC
    LIMIT ${limit}
  `;

  return c.json({
    trending: rows.map(r => ({
      topic: r.topic,
      articles: Number(r.article_count),
      users: Number(r.engaged_users),
      clicks: Number(r.clicks),
    })),
    region,
    window_hours: hours,
  });
});

// ── GET /api/analytics/user-location ────────────────────────────────────
//
// Get user's location (from session)
analyticsRoute.get("/analytics/user-location", async (c) => {
  // FIX_NOTES 2.4 (IDOR): returned precise home/active coordinates for ANY
  // session_id, unauthenticated, and no first-party caller exists (checked
  // public_html, dev, scripts). Restricted to super-admin (support/ops
  // lookup); restore a session-ownership flow only if a client needs it.
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;
  const sessionId = c.req.query("session_id");
  if (!sessionId) {
    return c.json({ error: "session_id required" }, 400);
  }

  const sql = getDb();
  const rows = await sql<any[]>`
    SELECT
      home_lat, home_lng, home_city, home_country, home_set_at,
      detected_lat, detected_lng, detected_city, detected_country,
      active_lat, active_lng, active_source
    FROM news_user_locations
    WHERE session_id = ${sessionId}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return c.json({ found: false });
  }

  const r = rows[0];
  return c.json({
    found: true,
    home: r.home_set_at ? {
      lat: Number(r.home_lat),
      lng: Number(r.home_lng),
      city: r.home_city,
      country: r.home_country,
    } : null,
    detected: r.detected_at ? {
      lat: Number(r.detected_lat),
      lng: Number(r.detected_lng),
      city: r.detected_city,
      country: r.detected_country,
    } : null,
    active: {
      lat: Number(r.active_lat),
      lng: Number(r.active_lng),
      source: r.active_source,
    },
  });
});

// ── POST /api/analytics/calculate ───────────────────────────────────────
//
// Trigger ranking calculations (admin endpoint)
analyticsRoute.post("/analytics/calculate", async (c) => {
  // Tier 1.6: gate — triggers two expensive SQL functions. Repeat calls
  // are a DoS vector (CPU + DB pressure).
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;

  const sql = getDb();

  await sql`SELECT calculate_source_rankings()`;
  await sql`SELECT calculate_geo_interest(24)`;

  return c.json({ ok: true, message: "Rankings recalculated" });
});

// ── GET /api/analytics/stats ────────────────────────────────────────────
//
// Get overall analytics stats. Returns headline counts plus the four
// "Top X" arrays the help page renders:
//   top_articles — most-clicked articles (pin_click events, 24h)
//   top_cities   — most-pinned locations with full country name + region
//   top_sources  — most-published sources by article volume
//   top_helpers  — top community contributors (votes + bug reports)
analyticsRoute.get("/analytics/stats", async (c) => {
  const sql = getDb();

  const stats = await sql<any[]>`
    SELECT
      (SELECT COUNT(*) FROM news_interactions WHERE created_at > now() - interval '24 hours') as interactions_24h,
      (SELECT COUNT(DISTINCT session_id) FROM news_interactions WHERE created_at > now() - interval '24 hours') as users_24h,
      (SELECT COUNT(*) FROM news_interactions WHERE interaction_type = 'pin_click' AND created_at > now() - interval '24 hours') as pin_clicks_24h,
      (SELECT COUNT(*) FROM news_interactions WHERE interaction_type = 'search' AND created_at > now() - interval '24 hours') as searches_24h,
      (SELECT COUNT(*) FROM news_user_locations WHERE home_set_at IS NOT NULL) as users_with_homes,
      (SELECT COUNT(*) FROM news_user_locations WHERE detected_at IS NOT NULL) as users_detected,
      (SELECT COUNT(*) FROM news_client_errors WHERE created_at > now() - interval '24 hours') as client_errors_24h,
      (SELECT COUNT(*) FROM news_client_errors WHERE created_at > now() - interval '1 hour') as client_errors_1h,
      (SELECT COUNT(*) FROM news_client_errors) as client_errors_total,
      (SELECT COUNT(*) FROM news_area_requests) as discovery_runs,
      (SELECT COUNT(*) FROM news_search_log WHERE created_at > now() - interval '1 hour') as searches_1h,
      (SELECT COUNT(*) FROM news_articles WHERE extracted_at > now() - interval '1 hour') as articles_extracted_1h,
      (SELECT COUNT(*) FROM news_sources WHERE active = TRUE AND deleted_at IS NULL) as active_sources,
      (SELECT COUNT(*) FROM news_sources WHERE deleted_at IS NULL) as total_sources,
      (SELECT COUNT(*) FROM news_articles WHERE published_at > now() - interval '24 hours') as articles_24h,
      (SELECT COUNT(*) FROM news_articles) as articles_total,
      (SELECT COUNT(*) FROM news_location_views WHERE created_at > now() - interval '24 hours') as location_views_24h,
      (SELECT COUNT(*) FROM news_interactions WHERE interaction_type = 'set_home' AND created_at > now() - interval '24 hours') as set_home_24h,
      (SELECT COUNT(*) FROM news_area_requests WHERE requested_at > now() - interval '24 hours') as area_requests_24h,
      (SELECT COUNT(*) FROM feedback_bug_reports WHERE created_at > now() - interval '24 hours') as quality_reports_24h
  `;

  // Top articles by pin_click interactions in the last 24h (falls back to
  // most-recently-published articles when there are no clicks yet).
  // Tier 1.4: filter retired sources so deleted sources don't leak into
  // the public top-articles card on the help page.
  const top_articles = await sql<any[]>`
    SELECT a.id, a.title, a.url, s.name AS source_name,
           COUNT(i.id)::int AS clicks
    FROM news_articles a
    JOIN news_sources s ON s.id = a.source_id
    LEFT JOIN news_interactions i
      ON i.interaction_type = 'pin_click'
     AND i.article_id = a.id
     AND i.created_at > now() - interval '24 hours'
    WHERE a.status = 'extracted'
      AND s.deleted_at IS NULL
    GROUP BY a.id, a.title, a.url, s.name
    ORDER BY clicks DESC, a.fetched_at DESC
    LIMIT 6
  `;

  // Top cities by article count (last 30 days). The place_name column
  // typically already ends with ", XX" (e.g. "Washington, US"), and the
  // standalone news_locations.country column is rarely populated, so we
  // extract the country code from the suffix when present and fall
  // through to the country column otherwise.
  const top_cities = await sql<any[]>`
    SELECT l.id, l.place_name AS city, l.country AS country_code,
           l.lat, l.lng,
           COUNT(a.id)::int AS visitors
    FROM news_locations l
    JOIN news_articles a
      ON a.location_id = l.id
     AND COALESCE(a.published_at, a.fetched_at) > now() - interval '30 days'
    WHERE l.place_name IS NOT NULL
    GROUP BY l.id, l.place_name, l.country, l.lat, l.lng
    ORDER BY visitors DESC, l.id DESC
    LIMIT 6
  `;

  // Top news sources by article volume (last 30 days). We pair the
  // 2-letter country code with COUNTRY_NAMES on the frontend.
  // Tier 1.4: filter retired sources so the public top-sources card
  // on the help page never shows a soft-deleted source.
  const top_sources = await sql<any[]>`
    SELECT s.id, s.name, s.country AS country_code, s.language,
           COUNT(a.id)::int AS n
    FROM news_sources s
    JOIN news_articles a
      ON a.source_id = s.id
     AND COALESCE(a.published_at, a.fetched_at) > now() - interval '30 days'
    WHERE s.active = true
      AND s.deleted_at IS NULL
    GROUP BY s.id, s.name, s.country, s.language
    ORDER BY n DESC, s.id ASC
    LIMIT 6
  `;

  // Top community helpers — union of bug reports + extraction/link
  // feedback grouped by requester_ip or session_id. Anonymized to a
  // short hash for display so we don't leak raw IPs in the dashboard.
  const top_helpers = await sql<any[]>`
    SELECT contributor, SUM(n)::int AS contributions FROM (
      SELECT COALESCE(requester_ip::text, session_id, 'anon') AS contributor,
             COUNT(*)::int AS n
      FROM feedback_bug_reports
      WHERE created_at > now() - interval '30 days'
      GROUP BY COALESCE(requester_ip::text, session_id, 'anon')
      UNION ALL
      SELECT COALESCE(session_id, 'anon') AS contributor,
             COUNT(*)::int AS n
      FROM news_search_log
      WHERE created_at > now() - interval '30 days'
        AND session_id IS NOT NULL
      GROUP BY COALESCE(session_id, 'anon')
    ) s
    WHERE contributor <> 'anon'
    GROUP BY contributor
    ORDER BY contributions DESC
    LIMIT 6
  `;

  const s = stats[0];

  return c.json({
    interactions_24h: Number(s.interactions_24h),
    users_24h: Number(s.users_24h),
    pin_clicks_24h: Number(s.pin_clicks_24h),
    searches_24h: Number(s.searches_24h),
    users_with_homes: Number(s.users_with_homes),
    users_detected: Number(s.users_detected),
    client_errors_24h: Number(s.client_errors_24h),
    client_errors_1h: Number(s.client_errors_1h),
    client_errors_total: Number(s.client_errors_total),
    discovery_runs: Number(s.discovery_runs),
    searches_1h: Number(s.searches_1h),
    articles_extracted_1h: Number(s.articles_extracted_1h),
    active_sources: Number(s.active_sources),
    total_sources: Number(s.total_sources),
    articles_24h: Number(s.articles_24h),
    articles_total: Number(s.articles_total),
    location_views_24h: Number(s.location_views_24h),
    set_home_24h: Number(s.set_home_24h),
    area_requests_24h: Number(s.area_requests_24h),
    quality_reports_24h: Number(s.quality_reports_24h),
    top_articles: top_articles.map((a) => ({
      id: Number(a.id),
      title: a.title,
      url: a.url,
      source_name: a.source_name,
      clicks: a.clicks,
    })),
    top_cities: top_cities.map((c) => {
      // Extract the country code from place_name suffix when present
      // ("Washington, US" → "US"). The standalone news_locations.country
      // is sparsely populated, so the suffix is the reliable source.
      // Only accept known ISO alpha-2 codes — ", NY" or ", CA" are US
      // states, not countries, and would mislead the region lookup.
      let cc = c.country_code || null;
      if (!cc && typeof c.city === "string") {
        const m = c.city.match(/,\s*([A-Za-z]{2,3})\s*$/);
        if (m && COUNTRY_NAMES[m[1].toUpperCase()]) cc = m[1].toUpperCase();
      }
      // Strip the country suffix from the displayed city name so we
      // don't show "Washington, US" alongside a separate "US" column.
      let cityName = c.city || "";
      if (cc && typeof cityName === "string") {
        cityName = cityName.replace(/,\s*[A-Za-z]{2,3}\s*$/, "").trim();
      }
      return {
        id: Number(c.id),
        city: cityName,
        country: cc,
        region: REGION_FOR_COUNTRY[cc] || null,
        country_name: COUNTRY_NAMES[cc] || cc || null,
        lat: Number(c.lat),
        lng: Number(c.lng),
        visitors: c.visitors,
      };
    }),
    top_sources: top_sources.map((s) => ({
      id: Number(s.id),
      name: s.name,
      country: s.country_code,
      country_name: COUNTRY_NAMES[s.country_code] || s.country_code || null,
      language: s.language,
      n: s.n,
    })),
    top_helpers: top_helpers.map((h) => ({
      contributor: String(h.contributor).slice(0, 12),
      contributions: h.contributions,
    })),
  });
});

// ── Quality Reports ────────────────────────────────────────────────────

// Rate limiter for quality reports (5 per hour per IP)
const reportLimiter = new RateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });

// ── POST /api/analytics/report-quality ──────────────────────────────────
//
// Report a news story as poor quality
const QualityReportSchema = z.object({
  article_id: z.number().int().min(0).optional(),
  session_id: z.string().min(1).max(100),
  report_type: z.enum([
    'misleading', 'false_info', 'spam', 'outdated',
    'duplicate', 'low_quality', 'offensive', 'other',
    'rerun_requested',
    // Access-quality reports — the story may be fine but the source
    // gates it behind a paywall or account. Tracked separately so the
    // admin queue can suppress them without losing the signal.
    'paywall', 'login_required',
  ]),
  reason: z.string().max(500).optional(),
});

analyticsRoute.post(
  "/analytics/report-quality",
  zValidator("json", QualityReportSchema),
  async (c) => {
    // Gate ["editorial"]: editorial users flag bad content for
    // triage; public users hit /quick-flag instead (which has its
    // own rate-limited, narrowed payload).
    const gate = await adminAuth(c, ["editorial"]);
    if (!gate.ok) return gate.response;

    const ip = getClientIp(c.req.raw);
    const rl = reportLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
    }

    const data = c.req.valid("json");
    const sql = getDb();

    // System-level reports (e.g. rerun_requested) don't reference a
    // specific article. article_id=0 or undefined means "system".
    const isSystemReport = !data.article_id || data.article_id === 0;

    let article: any[] = [];
    if (!isSystemReport) {
      // Check if article exists (and grab title + body for the
      // admin-sniff context: when a user reports a story, we run the
      // cities engine over the article to surface likely locations in
      // the admin triage queue.)
      article = await sql<any[]>`
        SELECT id, title, body, source_id, location_id, report_count
        FROM news_articles WHERE id = ${data.article_id}
      `;
      if (!article[0]) {
        return c.json({ error: "article_not_found" }, 404);
      }
    }

    // Insert report (will fail silently if duplicate)
    const reportIp = ip !== 'unknown' ? ip : null;
    try {
      await sql`
        INSERT INTO news_quality_reports (article_id, session_id, report_type, reason, ip_address)
        VALUES (${isSystemReport ? null : data.article_id}, ${data.session_id}, ${data.report_type}, ${data.reason || null}, ${reportIp}::inet)
      `;
    } catch (e: any) {
      if (e.message?.includes('unique') || e.message?.includes('duplicate')) {
        return c.json({ error: "already_reported", message: "You've already reported this article for this reason." }, 409);
      }
      throw e;
    }

    // Admin sniff context: run cities_text against the article body
    // and persist the result on the report row. This gives admins a
    // "probably in {X}" hint in the triage queue. Best-effort.
    // Skip for system-level reports (no article to sniff).
    //
    // Queue migration: the inline `python3 -c "..."` is gone; the helper
    // now lives at `worker.analytics_inline.sniff_article_cities` and
    // runs under the `analytics_inline` job kind (3s sync-wait
    // budget). The result shape is unchanged.
    if (!isSystemReport && article[0]) {
      try {
        const result = await enqueueOrSpawn<Record<string, unknown>>(
          "analytics_inline",
          {
            op: "sniff_article_cities",
            text: (article[0].title || "") + "\n" + (article[0].body || "").slice(0, 3000),
          },
          { waitMs: 3000, enqueuedBy: "api/analytics/report-quality/sniff" },
        );
        // Async (worker still running) — drop the sniff result for now.
        // The admin triage queue can re-run sniff on demand if needed.
        if (result.kind === "async") {
          console.warn(
            "[report-quality] sniff async (requestId=%s) — skipping persist",
            result.requestId,
          );
        } else if (result.result && typeof result.result === "object") {
          await sql`
            UPDATE news_quality_reports
               SET sniff_result = ${JSON.stringify(result.result)}::jsonb
             WHERE article_id = ${data.article_id}
               AND session_id = ${data.session_id}
               AND report_type = ${data.report_type}
          `;
        }
      } catch (e) {
        // Best-effort sniff — never block report submission on a
        // worker failure. Matches pre-migration behavior (the inline
        // spawn swallowed errors via `resolve("")` on close).
        console.warn("[report-quality] sniff failed:", (e as Error).message);
      }
    }

    // Update article report count and quality score (skip for system-level reports)
    if (!isSystemReport && data.article_id) {
      const reportCounts = await sql<any[]>`
        SELECT
          COUNT(*) as total_reports,
          COUNT(*) FILTER (WHERE report_type IN ('false_info', 'misleading', 'spam')) as serious_reports
        FROM news_quality_reports
        WHERE article_id = ${data.article_id}
      `;

      const totalReports = Number(reportCounts[0]?.total_reports || 0);
      const seriousReports = Number(reportCounts[0]?.serious_reports || 0);

      // Calculate quality score (1.0 = perfect, 0.0 = terrible)
      const qualityScore = Math.max(0, 1.0 - (totalReports * 0.1) - (seriousReports * 0.15));

      // Auto-hide if too many reports
      const shouldHide = totalReports >= 5 || seriousReports >= 3;

      await sql`
        UPDATE news_articles
        SET report_count = ${totalReports},
            quality_score = ${qualityScore},
            hidden_at = CASE WHEN ${shouldHide} AND hidden_at IS NULL THEN now() ELSE hidden_at END,
            hidden_reason = CASE WHEN ${shouldHide} AND hidden_at IS NULL THEN 'auto-hidden: quality reports' ELSE hidden_reason END
        WHERE id = ${data.article_id}
      `;

      // Also hide the pin if article is hidden
      if (shouldHide) {
        await sql`
          UPDATE pins SET status = 'hidden'
          WHERE article_id = ${data.article_id} AND status = 'published'
        `;
      }

      // For paywall/login reports, flag other articles from same domain
      let domainFlagged = 0;
      if (data.report_type === 'paywall' || data.report_type === 'login_required') {
        const articleUrl = article[0]?.url;
        if (articleUrl) {
          try {
            const domain = new URL(articleUrl).hostname;
            if (domain) {
              const domainResult = await sql`
                UPDATE news_articles
                SET quality_score = GREATEST(0, quality_score - 0.15)
                WHERE url LIKE ${'%' + domain + '%'}
                  AND id != ${data.article_id}
                  AND quality_score > 0.3
              `;
              domainFlagged = domainResult.count || 0;

              // Also reduce source reliability
              if (article[0]?.source_id) {
                await sql`
                  UPDATE news_sources
                  SET reliability_score = GREATEST(0, reliability_score - 0.05)
                  WHERE id = ${article[0].source_id}
                `;
              }
            }
          } catch (_) {}
        }
      }

      // Trigger background URL validation for paywall/login reports.
      //
      // Queue migration: the inline `python3 -c "..."` is gone; the helper
      // now lives at `worker.analytics_inline.validate_url` and runs
      // under the `analytics_inline` job kind. The original spawn was
      // fire-and-forget (`detached: true`, `stdio: "ignore"`,
      // `child.unref()`); preserve that semantic by enqueueing with
      // `waitMs: 0`.
      if (data.report_type === 'paywall' || data.report_type === 'login_required') {
        try {
          await enqueueOrSpawn(
            "analytics_inline",
            { op: "validate_url", url: article[0]?.url || "" },
            { waitMs: 0, enqueuedBy: "api/analytics/report-quality/validate-url" },
          );
        } catch (e) {
          // Best-effort background work — never block the report
          // response on a worker failure (matches pre-migration's
          // empty-catch around `child.unref()`).
          console.warn(
            "[report-quality] validate-url enqueue failed:",
            (e as Error).message,
          );
        }
      }

      return c.json({
        ok: true,
        report_count: totalReports,
        quality_score: qualityScore,
        hidden: shouldHide,
        domain_flagged: domainFlagged,
      });
    }

    // System-level report (no article to update)
    return c.json({ ok: true, system_report: true });
  }
);

// ── POST /api/analytics/quick-flag ─────────────────────────────────────
//
// "Quick flag" — designed for the top-bar Flag button so users can report
// a problematic pin/article without having to navigate the map, find the
// pin, open the popup, and click Report. The user pastes either:
//
//   - A Xyzo article ID          (e.g. "12345")
//   - A Xyzo pin URL pattern     (e.g. "https://xyzo.org/?pin=12345")
//   - The source article's URL      (e.g. "https://sciencedaily.com/...")
//   - A shortener URL that wraps it (e.g. "https://rnkd.org/top/abc123")
//
// We resolve the input to a news_articles row, then delegate the actual
// insert + score/hide logic to the same code path as /report-quality by
// calling that handler internally. To keep the two routes from drifting,
// we just forward the validated payload after resolving article_id.
const quickFlagLimiter = new RateLimiter({ max: 10, windowMs: 60 * 60 * 1000 });
const QuickFlagSchema = z.object({
  // Free-form input: URL, pin/article ID, or shortener URL. We resolve it.
  input: z.string().min(1).max(2000),
  report_type: z.enum([
    'misleading', 'false_info', 'spam', 'outdated',
    'duplicate', 'low_quality', 'offensive', 'other',
    'paywall', 'login_required', 'wrong_location',
  ]),
  reason: z.string().max(500).optional(),
  session_id: z.string().min(1).max(100).optional(),
});

// Resolve free-form input → news_articles row.
//
// Accepts:
//   - a numeric pin/article ID            ("12345")
//   - a Xyzo URL with pin param        ("https://xyzo.org/?pin=12345")
//   - any URL where the last numeric path-segment is a pin ID
//   - a shortener URL that wraps the article URL ("rnkd.org/top/abc123")
//   - the article's own URL              ("https://sciencedaily.com/...")
//
// Returns either:
//   { article: {id, title, url} }   on success
//   { error, message, status }      when nothing matched
async function resolveQuickFlagInput(raw: string): Promise<
  | { article: { id: number; title: string; url: string } }
  | { error: string; message: string; status: number }
> {
  const sql = getDb();
  let input = raw.trim();
  let candidate: string | null = null;
  let explicitId: number | null = null;

  // (a) Pure digits → treat as a news_articles.id (the /api/pins
  //     UNION returns article IDs directly for RSS pins).
  if (/^\d{1,12}$/.test(input)) {
    explicitId = Number(input);
  } else {
    // (b) Looks like a URL — normalize + try to extract a numeric ID
    //     from common patterns ("?pin=NNN", "/pin/NNN", "/p/NNN").
    try {
      // Add a fake scheme so URL parsing works for "example.com/foo".
      const url = new URL(input.includes("://") ? input : `https://${input}`);
      const pinParam =
        url.searchParams.get("pin") ||
        url.searchParams.get("id") ||
        url.searchParams.get("article");
      if (pinParam && /^\d+$/.test(pinParam)) {
        explicitId = Number(pinParam);
      }
      // Last path segment that's purely numeric → pin ID
      const segments = url.pathname.split("/").filter(Boolean);
      for (let i = segments.length - 1; i >= 0; i--) {
        if (/^\d+$/.test(segments[i])) {
          explicitId = Number(segments[i]);
          break;
        }
      }
      // Drop utm_* tracking params and the hash before using as the
      // canonical lookup key. Keep scheme + host + path + (filtered)
      // query so a shortener URL like "rnkd.org/top/debug-test" still
      // works when the article's stored URL includes the same path.
      for (const key of [...url.searchParams.keys()]) {
        if (/^utm_|^fbclid|^gclid$/i.test(key)) url.searchParams.delete(key);
      }
      url.hash = "";
      candidate = url.toString();
    } catch {
      // Not a parseable URL — fall through and try the literal as a
      // substring match against news_articles.url.
      candidate = input;
    }
  }

  // ── Resolve to a news_articles row ──────────────────────────────
  let article: { id: number; title: string; url: string } | null = null;

  if (explicitId !== null) {
    // Try news_articles.id first, then pins.id (some IDs only exist
    // in one of the two tables depending on whether the pin was
    // generated via the legacy or RSS pipeline). Cast to Number so
    // JSON.stringify doesn't choke on BigInt (postgres.js returns
    // int8 as BigInt by default).
    const rows = await sql<any[]>`
      SELECT id, title, url FROM news_articles WHERE id = ${explicitId} LIMIT 1
    `;
    if (rows[0]) {
      article = { id: Number(rows[0].id), title: rows[0].title, url: rows[0].url };
    } else {
      const pinRows = await sql<any[]>`
        SELECT p.id AS id, COALESCE(p.title, '') AS title,
               COALESCE(rd.source_url, '') AS url
        FROM pins p
        LEFT JOIN rss_details rd ON rd.pin_id = p.id
        WHERE p.id = ${explicitId} LIMIT 1
      `;
      if (pinRows[0]) {
        article = { id: Number(pinRows[0].id), title: pinRows[0].title, url: pinRows[0].url };
      }
    }
  } else if (candidate) {
    // Match on the article URL. Try exact match first, then a less
    // strict "url contains the candidate" match so URL shorteners
    // (rnkd.org, bit.ly, etc.) that redirect to the canonical URL
    // still find the article. This is intentionally fuzzy because
    // shorteners strip query strings — admins can disambiguate
    // duplicates in the triage queue.
    let rows = await sql<any[]>`
      SELECT id, title, url FROM news_articles WHERE url = ${candidate} LIMIT 1
    `;
    if (!rows[0]) {
      rows = await sql<any[]>`
        SELECT id, title, url FROM news_articles
        WHERE url LIKE ${`%${candidate.slice(0, 200)}%`}
        ORDER BY fetched_at DESC NULLS LAST LIMIT 1
      `;
    }
    if (rows[0]) {
      article = { id: Number(rows[0].id), title: rows[0].title, url: rows[0].url };
    }
  }

  if (!article) {
    return {
      error: "not_found",
      status: 404,
      message:
        "Couldn't find a Xyzo pin matching that input. Paste a numeric " +
        "pin/article ID, a xyzo.org URL, or the article's source URL.",
    };
  }
  return { article };
}

analyticsRoute.post(
  "/analytics/quick-flag",
  zValidator("json", QuickFlagSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = quickFlagLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
    }

    const data = c.req.valid("json");
    const sql = getDb();
    // Quick wins: crypto.randomUUID is collision-free; Math.random isn't.
    const sessionId = data.session_id
      || `anon_${crypto.randomUUID()}`;

    // ── Step 1+2: normalize the input and resolve to an article ────
    const lookup = await resolveQuickFlagInput(data.input);
    if ("error" in lookup) {
      return c.json({ error: lookup.error, message: lookup.message }, lookup.status as any);
    }
    const article = lookup.article;

    // ── Step 3: insert the report (delegating to the same logic) ────
    // Re-use the /report-quality code path by calling it via the route
    // is awkward — instead we just replicate the small piece that
    // actually writes. Keeping two parallel paths in sync is fine here
    // because the post-insert side-effects (report_count, hidden_at)
    // are simple and stable.
    const reportIp = ip !== "unknown" ? ip : null;
    try {
      await sql`
        INSERT INTO news_quality_reports (article_id, session_id, report_type, reason, ip_address)
        VALUES (${article.id}, ${sessionId}, ${data.report_type}, ${data.reason || null}, ${reportIp}::inet)
      `;
    } catch (e: any) {
      if (e.message?.includes("unique") || e.message?.includes("duplicate")) {
        return c.json({
          error: "already_reported",
          message: "You've already reported this article for this reason.",
        }, 409);
      }
      throw e;
    }

    // Refresh counters + auto-hide thresholds, same as /report-quality.
    const counts = await sql<any[]>`
      SELECT
        COUNT(*) AS total_reports,
        COUNT(*) FILTER (WHERE report_type IN ('false_info', 'misleading', 'spam')) AS serious_reports
      FROM news_quality_reports
      WHERE article_id = ${article.id}
    `;
    const totalReports = Number(counts[0]?.total_reports || 0);
    const seriousReports = Number(counts[0]?.serious_reports || 0);
    const qualityScore = Math.max(0, 1.0 - (totalReports * 0.1) - (seriousReports * 0.15));
    const shouldHide = totalReports >= 5 || seriousReports >= 3;

    await sql`
      UPDATE news_articles
      SET report_count = ${totalReports},
          quality_score = ${qualityScore},
          hidden_at = CASE WHEN ${shouldHide} AND hidden_at IS NULL THEN now() ELSE hidden_at END,
          hidden_reason = CASE WHEN ${shouldHide} AND hidden_at IS NULL THEN 'auto-hidden: quality reports' ELSE hidden_reason END
      WHERE id = ${article.id}
    `;
    if (shouldHide) {
      await sql`
        UPDATE pins SET status = 'hidden'
        WHERE article_id = ${article.id} AND status = 'published'
      `;
    }

    return c.json({
      ok: true,
      article_id: article.id,
      article_title: article.title,
      article_url: article.url,
      report_count: totalReports,
      quality_score: qualityScore,
      hidden: shouldHide,
    });
  }
);

// ── POST /api/analytics/quick-flag/lookup ──────────────────────────────
//
// Pure-resolution variant of /quick-flag — does the URL/ID → article
// lookup WITHOUT inserting a report. Used by the top-bar Flag dialog so
// the user can confirm "yes, that's the pin I meant to flag" before
// actually submitting. Sharing the same lookup helpers keeps the two
// endpoints from drifting apart.
//
// Same rate limiter as /quick-flag so an abuser can't bypass it by
// hammering lookup instead of submit.
analyticsRoute.post(
  "/analytics/quick-flag/lookup",
  zValidator("json", QuickFlagSchema.pick({ input: true })),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = quickFlagLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
    }

    const { input } = c.req.valid("json");
    const lookup = await resolveQuickFlagInput(input);
    if ("error" in lookup) {
      return c.json(lookup, lookup.status as any);
    }
    return c.json({
      ok: true,
      article_id: lookup.article.id,
      article_title: lookup.article.title,
      article_url: lookup.article.url,
    });
  }
);

// ── GET /api/analytics/reports/:articleId ─────────────────────────────
// Get reports for a specific article. Used by pin popup to show report status.
analyticsRoute.get("/analytics/reports/:articleId", async (c) => {
  const articleId = Number(c.req.param("articleId"));
  if (!Number.isInteger(articleId) || articleId < 1) {
    return c.json({ error: "bad_id" }, 400);
  }

  const sql = getDb();

  const reports = await sql<any[]>`
    SELECT id, report_type, reason, created_at, session_id
    FROM news_quality_reports
    WHERE article_id = ${articleId}
    ORDER BY created_at DESC
    LIMIT 20
  `;

  const counts = await sql<any[]>`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE report_type = 'paywall') as paywall,
      COUNT(*) FILTER (WHERE report_type = 'login_required') as login_required,
      COUNT(*) FILTER (WHERE report_type = 'false_info') as false_info,
      COUNT(*) FILTER (WHERE report_type = 'misleading') as misleading,
      COUNT(*) FILTER (WHERE report_type = 'spam') as spam,
      COUNT(*) FILTER (WHERE report_type = 'low_quality') as low_quality,
      COUNT(*) FILTER (WHERE report_type = 'offensive') as offensive,
      COUNT(*) FILTER (WHERE report_type = 'duplicate') as duplicate,
      COUNT(*) FILTER (WHERE report_type = 'other') as other
    FROM news_quality_reports
    WHERE article_id = ${articleId}
  `;

  const article = await sql<any[]>`
    SELECT report_count, quality_score, hidden_at, hidden_reason
    FROM news_articles
    WHERE id = ${articleId}
  `;

  return c.json({
    article_id: articleId,
    total_reports: Number(counts[0]?.total || 0),
    counts: {
      total: Number(counts[0]?.total || 0),
      paywall: Number(counts[0]?.paywall || 0),
      login_required: Number(counts[0]?.login_required || 0),
      false_info: Number(counts[0]?.false_info || 0),
      misleading: Number(counts[0]?.misleading || 0),
      spam: Number(counts[0]?.spam || 0),
      low_quality: Number(counts[0]?.low_quality || 0),
      offensive: Number(counts[0]?.offensive || 0),
      duplicate: Number(counts[0]?.duplicate || 0),
      other: Number(counts[0]?.other || 0),
    },
    quality_score: article[0]?.quality_score != null ? Number(article[0].quality_score) : null,
    hidden: article[0]?.hidden_at != null,
    hidden_reason: article[0]?.hidden_reason,
    reports: reports.map((r) => ({
      id: Number(r.id),
      report_type: r.report_type,
      reason: r.reason,
      created_at: r.created_at,
    })),
  });
});

// ── GET /api/analytics/reported-articles ────────────────────────────────
//
// Get articles with quality reports (admin view)
analyticsRoute.get("/analytics/reported-articles", async (c) => {
  // Tier 1.6: gate — exposes moderation queue (titles + URLs + report
  // counts) which is operator-only.
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;

  const limit = Math.min(Number(c.req.query("limit") || 50), 200);
  const minReports = Number(c.req.query("min_reports") || 1);
  const sql = getDb();

  const rows = await sql<any[]>`
    SELECT
      a.id,
      a.title,
      a.url,
      a.report_count,
      a.quality_score,
      a.hidden_at,
      a.hidden_reason,
      a.fetched_at,
      ns.name as source_name,
      ns.country as source_country,
      (
        SELECT json_agg(json_build_object(
          'type', r.report_type,
          'reason', r.reason,
          'created_at', r.created_at
        ) ORDER BY r.created_at DESC)
        FROM news_quality_reports r
        WHERE r.article_id = a.id
        LIMIT 5
      ) as recent_reports
    FROM news_articles a
    LEFT JOIN news_sources ns ON ns.id = a.source_id
    WHERE a.report_count >= ${minReports}
      -- Tier 1.4: filter retired sources so they don't leak into public listings.
      AND ns.deleted_at IS NULL
    ORDER BY a.report_count DESC, a.quality_score ASC
    LIMIT ${limit}
  `;

  return c.json({
    articles: rows.map(r => ({
      id: Number(r.id),
      title: r.title,
      url: r.url,
      report_count: Number(r.report_count),
      quality_score: Number(r.quality_score),
      hidden: r.hidden_at != null,
      hidden_reason: r.hidden_reason,
      fetched_at: r.fetched_at,
      source: {
        name: r.source_name,
        country: r.source_country,
      },
      recent_reports: r.recent_reports || [],
    })),
    total: rows.length,
  });
});

// ── POST /api/analytics/hide-article ────────────────────────────────────
//
// Manually hide an article (admin action)
const HideArticleSchema = z.object({
  article_id: z.number().int().positive(),
  reason: z.string().max(500),
});

analyticsRoute.post(
  "/analytics/hide-article",
  zValidator("json", HideArticleSchema),
  async (c) => {
    // Tier 1.6: gate — hides any article by id (no ownership check on
    // the article). Unauthenticated callers could shadow-hide content.
    const gate = await adminAuth(c, ["super"]);
    if (!gate.ok) return gate.response;

    const data = c.req.valid("json");
    const sql = getDb();

    await sql`
      UPDATE news_articles
      SET hidden_at = now(),
          hidden_reason = ${data.reason}
      WHERE id = ${data.article_id}
    `;

    await sql`
      UPDATE pins SET status = 'hidden'
      WHERE article_id = ${data.article_id} AND status = 'published'
    `;

    return c.json({ ok: true });
  }
);

// ── POST /api/analytics/unhide-article ──────────────────────────────────
//
// Restore a hidden article
const UnhideArticleSchema = z.object({
  article_id: z.number().int().positive(),
});

analyticsRoute.post(
  "/analytics/unhide-article",
  zValidator("json", UnhideArticleSchema),
  async (c) => {
    // Tier 1.6: gate — same rationale as hide-article.
    const gate = await adminAuth(c, ["super"]);
    if (!gate.ok) return gate.response;

    const data = c.req.valid("json");
    const sql = getDb();

    await sql`
      UPDATE news_articles
      SET hidden_at = NULL,
          hidden_reason = NULL
      WHERE id = ${data.article_id}
    `;

    await sql`
      UPDATE pins SET status = 'published'
      WHERE article_id = ${data.article_id} AND status = 'hidden'
    `;

    return c.json({ ok: true });
  }
);

// ── GET /api/analytics/quality-stats ────────────────────────────────────
//
// Get quality report statistics. Gated ["super"]: aggregate report
// counts (low_quality, false_info, paywall) reveal moderation queue
// pressure and are operator-only.
analyticsRoute.get("/analytics/quality-stats", async (c) => {
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;

  const sql = getDb();

  const stats = await sql<any[]>`
    SELECT
      (SELECT COUNT(*) FROM news_quality_reports) as total_reports,
      (SELECT COUNT(*) FROM news_quality_reports WHERE created_at > now() - interval '24 hours') as reports_24h,
      (SELECT COUNT(DISTINCT article_id) FROM news_quality_reports) as articles_reported,
      (SELECT COUNT(*) FROM news_articles WHERE hidden_at IS NOT NULL) as articles_hidden,
      (SELECT COUNT(*) FROM news_articles WHERE quality_score < 0.5) as low_quality,
      (SELECT json_build_object(
        'misleading', COUNT(*) FILTER (WHERE report_type = 'misleading'),
        'false_info', COUNT(*) FILTER (WHERE report_type = 'false_info'),
        'spam', COUNT(*) FILTER (WHERE report_type = 'spam'),
        'outdated', COUNT(*) FILTER (WHERE report_type = 'outdated'),
        'duplicate', COUNT(*) FILTER (WHERE report_type = 'duplicate'),
        'low_quality', COUNT(*) FILTER (WHERE report_type = 'low_quality'),
        'offensive', COUNT(*) FILTER (WHERE report_type = 'offensive'),
        'other', COUNT(*) FILTER (WHERE report_type = 'other')
      ) FROM news_quality_reports) as reports_by_type,
      -- Newer report types bucketed separately so the count grid stays
      -- readable. 'paywall' and 'login_required' surface stories that
      -- can't be read without a subscription or account; the admin
      -- triage queue filters them out by default because the source
      -- itself isn't broken.
      (SELECT json_build_object(
        'paywall', COUNT(*) FILTER (WHERE report_type = 'paywall'),
        'login_required', COUNT(*) FILTER (WHERE report_type = 'login_required')
      ) FROM news_quality_reports) as reports_by_access
  `;

  const s = stats[0];

  return c.json({
    total_reports: Number(s.total_reports),
    reports_24h: Number(s.reports_24h),
    articles_reported: Number(s.articles_reported),
    articles_hidden: Number(s.articles_hidden),
    low_quality: Number(s.low_quality),
    reports_by_type: s.reports_by_type,
    reports_by_access: s.reports_by_access,
  });
});

// ── GET /api/analytics/visitors/countries ────────────────────────────
// Visitor counts grouped by country. Gated ["super"]: per-country
// visitor + city counts reveal our geographic reach to competitors.
analyticsRoute.get("/analytics/visitors/countries", async (c) => {
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;

  const sql = getDb();

  // Response size cap (Tier response-size-caps, Audit 4): the country
  // vocabulary is bounded (~250 ISO codes + a few synthetic labels) but
  // the COALESCE() expression can collapse unusual detected_country
  // strings into many rows. Cap at 300 so a misconfigured upstream
  // detector can't blow up the response.
  const rows = await sql<any[]>`
    SELECT COALESCE(detected_country, home_country, 'Unknown') as country,
           COUNT(DISTINCT session_id) as visitors,
           COUNT(DISTINCT COALESCE(detected_city, home_city)) as cities,
           MAX(last_seen_at) as last_seen
    FROM news_user_locations
    GROUP BY COALESCE(detected_country, home_country, 'Unknown')
    ORDER BY visitors DESC
    LIMIT 300
  `;

  return c.json({
    countries: rows.map((r) => ({
      country: r.country,
      visitors: Number(r.visitors),
      cities: Number(r.cities),
      last_seen: r.last_seen,
    })),
    capped: rows.length >= 300,
  });
});

// ── GET /api/analytics/visitors/cities ───────────────────────────────
// Visitor counts grouped by city. Gated ["super"]: city-level
// breakdowns are more revealing than country-level; operator-only.
analyticsRoute.get("/analytics/visitors/cities", async (c) => {
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;

  const sql = getDb();

  const rows = await sql<any[]>`
    SELECT COALESCE(detected_city, home_city, 'Unknown') as city,
           COALESCE(detected_country, home_country, '?') as country,
           COUNT(DISTINCT session_id) as visits,
           MAX(last_seen_at) as last_seen
    FROM news_user_locations
    WHERE COALESCE(detected_city, home_city) IS NOT NULL
    GROUP BY COALESCE(detected_city, home_city, 'Unknown'),
             COALESCE(detected_country, home_country, '?')
    ORDER BY visits DESC
    LIMIT 50
  `;

  return c.json({
    cities: rows.map((r) => ({
      city: r.city,
      country: r.country,
      visits: Number(r.visits),
      last_seen: r.last_seen,
    })),
  });
});

// ── GET /api/analytics/visitors/recent ───────────────────────────────
// Recent visitor activity. Gated ["super"]: per-session row includes
// session_id + city + country + last_seen, which is PII-adjacent and
// could enable correlation if exposed.
analyticsRoute.get("/analytics/visitors/recent", async (c) => {
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;

  const limit = Math.min(Number(c.req.query("limit") || 50), 200);
  const sql = getDb();

  const rows = await sql<any[]>`
    SELECT session_id,
           COALESCE(detected_city, home_city) as city,
           COALESCE(detected_country, home_country) as country,
           visit_count,
           last_seen_at,
           created_at,
           active_source
    FROM news_user_locations
    ORDER BY last_seen_at DESC NULLS LAST
    LIMIT ${limit}
  `;

  return c.json({
    visitors: rows.map((r) => ({
      session_id: r.session_id,
      city: r.city,
      country: r.country,
      visits: Number(r.visit_count || 1),
      last_seen: r.last_seen_at,
      created_at: r.created_at,
      source: r.active_source,
    })),
  });
});

// ── GET /api/analytics/visitors/daily ────────────────────────────────
// Daily unique visitor counts for the last 30 days. Public endpoint.
analyticsRoute.get("/analytics/visitors/daily", async (c) => {
  const days = Math.min(Number(c.req.query("days") || 30), 90);
  const sql = getDb();

  const rows = await sql<any[]>`
    SELECT DATE_TRUNC('day', last_seen_at)::date as day,
           COUNT(DISTINCT session_id) as unique_visitors,
           COUNT(*) as total_sessions
    FROM news_user_locations
    WHERE last_seen_at > now() - make_interval(days => ${days})
    GROUP BY DATE_TRUNC('day', last_seen_at)::date
    ORDER BY day DESC
  `;

  return c.json({
    daily: rows.map((r) => ({
      date: r.day,
      visitors: Number(r.unique_visitors),
      sessions: Number(r.total_sessions),
    })),
  });
});

// ── POST /api/analytics/client-error ────────────────────────────────
// Log client-side JavaScript errors for debugging.
const ClientErrorSchema = z.object({
  session_id: z.string().max(100).optional(),
  errors: z.array(z.object({
    type: z.string().max(50),
    message: z.string().max(500),
    filename: z.string().max(500).optional(),
    lineno: z.number().int().optional(),
    colno: z.number().int().optional(),
    stack: z.string().max(2000).optional(),
    url: z.string().max(500).optional(),
  })).max(10),
});

analyticsRoute.post(
  "/analytics/client-error",
  zValidator("json", ClientErrorSchema),
  async (c) => {
    const data = c.req.valid("json");
    const sql = getDb();
    const ip = getClientIp(c.req.raw);
    const userAgent = c.req.header("user-agent")?.slice(0, 500) || null;

    // Server-side PII sanitization — defense in depth against anything client missed
    function sanitizePII(str) {
      if (!str || typeof str !== 'string') return str;
      return str
        .replace(/(password|passwd|pwd)[=:]\s*["']?[^\s"'&]+/gi, '$1=[REDACTED]')
        .replace(/(api[_-]?key|apikey|token|auth|bearer|secret|client[_-]?secret)[=:]\s*["']?[^\s"'&]+/gi, '$1=[REDACTED]')
        .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
        .replace(/[?&](lat|lng|latitude|longitude|loc|location)[=][-0-9.]+/gi, '&$1=[REDACTED]')
        .replace(/\/home\/[^\/]+/g, '/home/[USER]')
        .replace(/C:\\Users\\[^\/\\]+/gi, 'C:\\Users\\[USER]')
        .replace(/localhost:[0-9]{2,}/gi, 'localhost:[PORT]')
        .replace(/\b(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+)\b/g, '[PRIVATE_IP]')
        .slice(0, 2000);
    }

    for (const err of data.errors) {
      await sql`
        INSERT INTO news_client_errors (
          session_id, error_type, message, filename, lineno, colno, stack, url, user_agent
        ) VALUES (
          ${data.session_id ?? null}, ${err.type ?? "unknown"}, ${sanitizePII(err.message?.slice(0, 500) ?? "no message")},
          ${sanitizePII(err.filename?.slice(0, 500)) ?? null}, ${err.lineno ?? null}, ${err.colno ?? null},
          ${sanitizePII(err.stack?.slice(0, 2000)) ?? null}, ${sanitizePII(err.url?.slice(0, 500)) ?? null}, ${userAgent}
        )
      `;
    }

    return c.json({ ok: true });
  }
);

// ── GET /api/analytics/client-errors ────────────────────────────────
// Get recent client-side errors (for system logs page). Gated
// ["super"]: error rows include session_id + filename + url, which
// combined with stack traces can leak user behavior. Operator-only.
analyticsRoute.get("/analytics/client-errors", async (c) => {
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;
  const limit = Math.min(Number(c.req.query("limit") || 100), 500);
  const type = c.req.query("type") || "";
  // Cap at 7d so a misconfigured UI doesn't drain the table. The frontend
  // passes fractional hours for "last X minutes" so we round up to seconds.
  const hoursRaw = Number(c.req.query("hours") || 24);
  const hours = Math.max(0.01, Math.min(168, hoursRaw));
  const sql = getDb();

  let rows;
  if (type) {
    rows = await sql<any[]>`
      SELECT id, error_type, message, filename, lineno, url, created_at
      FROM news_client_errors
      WHERE error_type = ${type}
        AND created_at > now() - (${hours}::float * interval '1 hour')
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  } else {
    rows = await sql<any[]>`
      SELECT id, error_type, message, filename, lineno, url, created_at
      FROM news_client_errors
      WHERE created_at > now() - (${hours}::float * interval '1 hour')
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  }

  // Counts respect the same window as the rows so the breakdown matches
  // the error list (previously hardcoded to 24h, mismatched the UI's
  // "last X minutes/hours" filter and made the type breakdown lie).
  const counts = await sql<any[]>`
    SELECT error_type, COUNT(*) as count
    FROM news_client_errors
    WHERE created_at > now() - (${hours}::float * interval '1 hour')
    GROUP BY error_type
    ORDER BY count DESC
  `;

  // Total count for the same window — used by the UI to render
  // "X errors in last Y hours" without making a second round-trip.
  const totalRow = await sql<any[]>`
    SELECT COUNT(*)::int AS total
    FROM news_client_errors
    WHERE created_at > now() - (${hours}::float * interval '1 hour')
  `;

  return c.json({
    errors: rows.map((r) => ({
      id: Number(r.id),
      error_type: r.error_type,
      message: r.message,
      filename: r.filename,
      lineno: r.lineno,
      url: r.url,
      created_at: r.created_at,
    })),
    counts: counts.map((r) => ({ type: r.error_type, count: Number(r.count) })),
    total: Number(totalRow[0]?.total ?? rows.length),
    hours,
  });
});

// ── GET /api/analytics/interactions ─────────────────────────────────
// Recent interaction log for the admin /help drill-down panel. Reads
// from news_interactions (the table the frontend writes to via
// /api/analytics/log). Returned shape mirrors the columns the help
// page's loadLiveActivity / loadLiveSearches consume — interaction_type,
// user_city, user_country, metadata, created_at.
//
// Caller: help/index.html:1640, 1732, 2220, 2293.
const InteractionsQuerySchema = z.object({
  type: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  since_h: z.coerce.number().int().min(1).max(8760).optional().default(72),
});

analyticsRoute.get(
  "/analytics/interactions",
  zValidator("query", InteractionsQuerySchema),
  async (c) => {
    // Tier 1.6: gate — returns session_id + user_city + user_country +
    // map coords for every interaction. Pure PII dump; super admin only.
    const gate = await adminAuth(c, ["super"]);
    if (!gate.ok) return gate.response;

    const { type, limit, since_h } = c.req.valid("query");
    const sql = getDb();

    const rows = await sql<any[]>`
      SELECT id, interaction_type, session_id, user_city, user_country,
             pin_id, article_id, source_id, map_lat, map_lng, map_zoom,
             bbox, metadata, created_at
      FROM news_interactions
      WHERE created_at >= now() - (${since_h}::text || ' hours')::interval
        ${type ? sql`AND interaction_type = ${type}` : sql``}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    const items = rows.map((r) => ({
      id: Number(r.id),
      interaction_type: r.interaction_type,
      session_id: r.session_id,
      user_city: r.user_city,
      user_country: r.user_country,
      pin_id: r.pin_id ? Number(r.pin_id) : null,
      article_id: r.article_id ? Number(r.article_id) : null,
      source_id: r.source_id ? Number(r.source_id) : null,
      map_lat: r.map_lat ? Number(r.map_lat) : null,
      map_lng: r.map_lng ? Number(r.map_lng) : null,
      map_zoom: r.map_zoom ? Number(r.map_zoom) : null,
      bbox: r.bbox,
      metadata: r.metadata,
      created_at: r.created_at,
    }));

    return c.json({
      items,
      count: items.length,
    });
  },
);

// ── GET /api/analytics/problems ─────────────────────────────────────
// Problem-pattern view for the admin /help diagnostics panel. The
// underlying table doesn't exist today; this stub returns an empty page
// so the drill-down doesn't 404. Caller: help/index.html:1908.
//
// When the problems table lands, swap the try/catch for a real SELECT.
const ProblemsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  since_h: z.coerce.number().int().min(1).max(8760).optional().default(168),
});

analyticsRoute.get(
  "/analytics/problems",
  zValidator("query", ProblemsQuerySchema),
  async (c) => {
    // Tier 1.6: gate — operator diagnostics view; surfaces internal
    // sample_payload blobs. Super admin only.
    const gate = await adminAuth(c, ["super"]);
    if (!gate.ok) return gate.response;

    const { limit, since_h } = c.req.valid("query");
    let items: Array<Record<string, unknown>> = [];
    let note: string | undefined = "problems table not yet provisioned; stub returns empty.";
    try {
      const sql = getDb();
      const rows = await sql<any[]>`
        SELECT id, kind, count, first_seen, last_seen, sample_payload
        FROM analytics_problems
        WHERE last_seen >= now() - (${since_h}::text || ' hours')::interval
        ORDER BY count DESC, last_seen DESC
        LIMIT ${limit}
      `;
      items = rows;
      note = undefined;
    } catch {
      // missing table → empty
    }
    return c.json({ items, count: items.length, note });
  },
);

// ── POST /api/analytics/reaction ──────────────────────────────────────
// Heart/star reactions on pins. Fire-and-forget from the client.
// Stores in analytics_reactions table (created below if needed).
const reactionLimiter = new RateLimiter({ windowMs: 60_000, max: 30 });

analyticsRoute.post(
  "/analytics/reaction",
  zValidator(
    "json",
    z.object({
      pin_id: z.number().int().positive(),
      reaction: z.enum(["love", "star"]),
      active: z.boolean(),
    })
  ),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const limiterKey = `reaction:${ip}`;
    if (!reactionLimiter.check(limiterKey).allowed) {
      return c.json({ ok: false, error: "rate_limited" }, 429);
    }

    const data = c.req.valid("json");
    const sql = getDb();

    try {
      if (data.active) {
        await sql`
          INSERT INTO analytics_reactions (pin_id, reaction, session_ip, created_at)
          VALUES (${data.pin_id}, ${data.reaction}, ${ip}::inet, now())
          ON CONFLICT DO NOTHING
        `;
      } else {
        await sql`
          DELETE FROM analytics_reactions
          WHERE ctid = (
            SELECT ctid FROM analytics_reactions
            WHERE pin_id = ${data.pin_id}
              AND reaction = ${data.reaction}
              AND session_ip = ${ip}::inet
            LIMIT 1
          )
        `;
      }
      return c.json({ ok: true });
    } catch (e) {
      // Table might not exist yet — silently succeed
      return c.json({ ok: true });
    }
  }
);

// ── POST /api/analytics/map-settings ────────────────────────────────────
// What this reader's map is set to, once the view has settled.
//
// The site already tracks interactions per session (analytics.js and its
// `xyzo.session` key); this is the same idea for the MAP rather than the
// news: which overlays are on, at what opacity, which preset they opened.
// It answers two questions the layers dropdown and the Cool maps presets
// currently guess at — which rows are worth putting where, and what a
// "Storm watch" map actually looks like to the people who open one.
//
// It REPLACES the session's rows for the day rather than appending, so a
// reader who flips twenty overlays still counts once each and a session
// that changes its mind does not inflate the aggregate.
const MapSettingsOverlaySchema = z.object({
  slug: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  pct: z.number().int().min(0).max(100).nullable().optional(),
});

const MapSettingsSchema = z.object({
  session_id: z.string().min(1).max(100),
  base: z.string().max(120).nullable().optional(),
  // ~40 overlays is the whole list; 60 is headroom, not an invitation.
  overlays: z.array(MapSettingsOverlaySchema).max(60).optional(),
  preset: z.string().max(60).nullable().optional(),
  density: z.string().max(20).nullable().optional(),
  isoStep: z.number().nullable().optional(),
  isoColour: z.string().max(30).nullable().optional(),
  isoSource: z.string().max(20).nullable().optional(),
  windStyle: z.string().max(30).nullable().optional(),
  windColour: z.string().max(30).nullable().optional(),
  device: z.enum(["phone", "desktop", "tablet"]).nullable().optional(),
  reason: z.enum(["settle", "change", "preset", "leave"]).optional(),
});

const mapSettingsLimiter = new RateLimiter({ max: 30, windowMs: 60 * 1000 });

analyticsRoute.post(
  "/analytics/map-settings",
  zValidator("json", MapSettingsSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = mapSettingsLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
    }
    const data = c.req.valid("json");
    const sql = getDb();
    const rows: Array<[string, string, string, number | null, string | null]> = [];

    if (data.base) rows.push(["base", data.base, "base", null, data.reason ?? null]);
    if (data.preset) rows.push(["preset", data.preset, "preset", null, data.reason ?? null]);
    for (const o of data.overlays ?? []) {
      rows.push(["overlay", o.slug, o.name, o.pct ?? null, data.reason ?? null]);
    }
    // The settings that are not layers at all — the isobar step and the
    // wind rendering are choices a reader makes and never sees in the
    // overlay list, so they would otherwise be invisible to this table.
    const scalar: Array<[string, string | null]> = [
      ["density", data.density ?? null],
      ["isoStep", data.isoStep == null ? null : String(data.isoStep)],
      ["isoColour", data.isoColour ?? null],
      ["isoSource", data.isoSource ?? null],
      ["windStyle", data.windStyle ?? null],
      ["windColour", data.windColour ?? null],
      ["device", data.device ?? null],
    ];
    for (const [k, v] of scalar) {
      if (v) rows.push(["setting", k, k, null, v]);
    }

    if (rows.length === 0) return c.json({ ok: true, rows: 0 });

    try {
      // One transaction: the DELETE and the INSERTs share it so a reader
      // never sees a half-written day.
      await sql.begin(async (tx) => {
        await tx`
          DELETE FROM map_settings_usage
          WHERE session_id = ${data.session_id} AND day = current_date`;
        // FIVE arrays, FIVE column names. The first version named four
        // and passed five, so `t.pct` resolved to the NAME column and
        // Postgres refused the insert with "pct is of type smallint but
        // expression is of type text" — an alias list that is one short
        // shifts every column after it.
        //
        // **THE UPSERT IS WHAT MAKES IT CONCURRENT-SAFE.** The natural
        // key is (day, session_id, kind, key) and the migration says so
        // ("the write stays idempotent") — but DELETE-then-INSERT is not
        // idempotent when two writes from the SAME session overlap:
        // both DELETEs find nothing, both INSERTs run, and the second
        // dies on `map_settings_usage_natural_key`. Measured: the
        // telemetry POST 500'd on roughly one page load in five, and
        // the client fires it whenever the view settles. The DELETE
        // stays (a session that turns a layer OFF must lose its row),
        // and the INSERT now lands on conflict instead of throwing.
        await tx`
          INSERT INTO map_settings_usage (day, session_id, kind, key, name, pct, reason)
          SELECT current_date, ${data.session_id},
                 t.kind, t.key, t.name, t.pct, t.reason
          FROM unnest(
            ${rows.map((r) => r[0])}::text[],
            ${rows.map((r) => r[1])}::text[],
            ${rows.map((r) => r[2])}::text[],
            ${rows.map((r) => r[3])}::int[],
            ${rows.map((r) => r[4])}::text[]
          ) AS t(kind, key, name, pct, reason)
          ON CONFLICT (day, session_id, kind, key) DO UPDATE
             SET name = EXCLUDED.name,
                 pct = EXCLUDED.pct,
                 reason = EXCLUDED.reason`;
      });
    } catch (err) {
      // A telemetry failure must never reach the reader as an error —
      // the map is the product, this is a footnote on it.
      console.error("[map-settings] write failed:", err);
      return c.json({ ok: false }, 500);
    }
    return c.json({ ok: true, rows: rows.length });
  },
);

// ── GET /api/analytics/map-settings ─────────────────────────────────────
// The report: which overlays are used, which presets are opened, and —
// for each preset — what the people who opened it actually had on.
//
// This is the number the layers dropdown is ordered by and the number a
// preset is tuned against. It reads the aggregate, never the raw rows,
// and it is capped like every other list endpoint here.
const MapSettingsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  preset: z.string().max(60).optional(),
});

analyticsRoute.get(
  "/analytics/map-settings",
  zValidator("query", MapSettingsQuerySchema),
  async (c) => {
    const q = c.req.valid("query");
    const sql = getDb();
    const since = new Date(Date.now() - q.days * 86400000);

    const overlays = await sql<any[]>`
      SELECT key AS slug,
             -- The display name, so the report reads "💨 Wind (GFS)"
             -- rather than "wind-gfs" and the client can match a row in
             -- the layers dropdown without rebuilding the slug table.
             min(name) AS name,
             count(DISTINCT session_id)::int AS sessions,
             avg(pct)::int AS pct,
             count(*)::int AS rows
      FROM map_settings_usage
      WHERE day >= ${since} AND kind = 'overlay'
      GROUP BY key
      ORDER BY sessions DESC
      LIMIT 60`;

    const presets = await sql<any[]>`
      SELECT key AS preset,
             count(DISTINCT session_id)::int AS sessions
      FROM map_settings_usage
      WHERE day >= ${since} AND kind = 'preset'
      GROUP BY key
      ORDER BY sessions DESC
      LIMIT 20`;

    const bases = await sql<any[]>`
      SELECT key AS base, count(DISTINCT session_id)::int AS sessions
      FROM map_settings_usage
      WHERE day >= ${since} AND kind = 'base'
      GROUP BY key ORDER BY sessions DESC LIMIT 20`;

    const settings = await sql<any[]>`
      SELECT key, value, count(DISTINCT session_id)::int AS sessions
      FROM (
        SELECT key, reason AS value, session_id
        FROM map_settings_usage
        WHERE day >= ${since} AND kind = 'setting'
      ) s
      GROUP BY key, value
      ORDER BY key, sessions DESC
      LIMIT 200`;

    // What a given preset LOOKS LIKE to the people who open it: the
    // overlays those sessions had on, with the opacity they settled at.
    // This is the number a preset is tuned against — a curated
    // "Storm watch" that everybody immediately turns the lightning off
    // in is a preset with a wrong layer in it.
    let typical: Array<Record<string, unknown>> = [];
    if (q.preset) {
      typical = await sql<any[]>`
        SELECT o.key AS slug,
               count(DISTINCT o.session_id)::int AS sessions,
               avg(o.pct)::int AS pct,
               round(100.0 * count(DISTINCT o.session_id) /
                     NULLIF((SELECT count(DISTINCT session_id)
                             FROM map_settings_usage
                             WHERE day >= ${since} AND kind = 'preset'
                               AND key = ${q.preset}), 0))::int AS pct_of_openers
        FROM map_settings_usage p
        JOIN map_settings_usage o
          ON o.session_id = p.session_id AND o.day = p.day AND o.kind = 'overlay'
        WHERE p.day >= ${since} AND p.kind = 'preset' AND p.key = ${q.preset}
        GROUP BY o.key
        ORDER BY sessions DESC
        LIMIT 60`;
    }

    const days = await sql<any[]>`
      SELECT count(DISTINCT day)::int AS days, count(DISTINCT session_id)::int AS sessions
      FROM map_settings_usage WHERE day >= ${since}`;

    return c.json({
      window_days: q.days,
      days: days[0]?.days ?? 0,
      sessions: days[0]?.sessions ?? 0,
      overlays,
      presets,
      bases,
      settings,
      typical,
    });
  },
);

// ── POST /api/analytics/perf ────────────────────────────────────────────
// What a real reader's browser actually did (2026-11-14).
//
// Owner ask: *"we need someone on the server side to help us understand
// how slow or how fast various situations are running on various
// peoples browsers so we can log them and try and study them on what we
// can do to speed it up for all users."*
//
// Until now every perf number this project had came from lab runs on
// one machine. Those found the wind's defects (a dt cap that halved the
// animation below 10 fps; wide round-capped strokes costing 80 % of the
// layer's canvas time — measured 3.7 fps and 15.6 px/s on the owner's
// fifteen-overlay link, against 20 fps and 38 px/s after) — but a lab
// cannot say how many readers are below 30 fps, or whether `gpu` reads
// llvmpipe on the machines that report the worst numbers.
//
// TWO ROWS PER SESSION PER DAY (`settled` and `wind`), written as an
// upsert on (day, session_id, phase): a retry, a second tab or a
// reload lands on the same row, so a reader who refreshes ten times
// still counts once and the aggregate stays a count of READERS.
//
// PRIVACY: the client parses the UA down to two strings ("Firefox/153",
// "Linux") before it sends anything — no IP is stored (only seen by the
// rate limiter), no raw user-agent, and `view` is the URL hash, i.e.
// the map a reader built, which map_move already sends as a bbox.
const PerfWindSchema = z.object({
  on: z.boolean(),
  style: z.string().max(30).nullable().optional(),
  density: z.number().int().min(0).max(1000).nullable().optional(),
  particles: z.number().int().min(0).max(100000).nullable().optional(),
  fps: z.number().min(0).max(1000).nullable().optional(),
  quality: z.number().min(0).max(10).nullable().optional(),
});

const PerfSchema = z.object({
  session_id: z.string().min(1).max(100),
  phase: z.enum(["settled", "wind"]),
  browser: z.string().max(60).nullable().optional(),
  os: z.string().max(30).nullable().optional(),
  device: z.enum(["phone", "tablet", "desktop"]).nullable().optional(),
  hw_concurrency: z.number().int().min(0).max(512).nullable().optional(),
  dpr: z.number().min(0.1).max(16).nullable().optional(),
  viewport_w: z.number().int().min(0).max(30000).nullable().optional(),
  viewport_h: z.number().int().min(0).max(30000).nullable().optional(),
  overlay_count: z.number().int().min(0).max(80).nullable().optional(),
  panes: z.number().int().min(0).max(400).nullable().optional(),
  canvas_px: z.number().int().min(0).max(4_000_000_000).nullable().optional(),
  gpu: z.string().max(160).nullable().optional(),
  probe_ms: z.number().min(0).max(60000).nullable().optional(),
  fps: z.number().min(0).max(1000).nullable().optional(),
  frame_p50_ms: z.number().min(0).max(600000).nullable().optional(),
  frame_p95_ms: z.number().min(0).max(600000).nullable().optional(),
  frame_worst_ms: z.number().min(0).max(600000).nullable().optional(),
  long_tasks: z.number().int().min(0).max(100000).nullable().optional(),
  long_busy_pct: z.number().min(0).max(100).nullable().optional(),
  wind: PerfWindSchema.nullable().optional(),
  dot_px_per_s: z.number().min(0).max(10000).nullable().optional(),
  dcl_ms: z.number().int().min(0).max(600000).nullable().optional(),
  load_ms: z.number().int().min(0).max(600000).nullable().optional(),
  view: z.string().max(400).nullable().optional(),
});

const perfLimiter = new RateLimiter({ max: 20, windowMs: 60 * 1000 });

analyticsRoute.post(
  "/analytics/perf",
  zValidator("json", PerfSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = perfLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
    }
    const d = c.req.valid("json");
    const sql = getDb();
    try {
      await sql`
        INSERT INTO client_perf (
          day, session_id, phase, browser, os, device, hw_concurrency, dpr,
          viewport_w, viewport_h, overlay_count, panes, canvas_px, gpu, probe_ms,
          fps, frame_p50_ms, frame_p95_ms, frame_worst_ms, long_tasks, long_busy_pct,
          wind, dot_px_per_s, dcl_ms, load_ms, view
        ) VALUES (
          current_date, ${d.session_id}, ${d.phase},
          ${d.browser ?? null}, ${d.os ?? null}, ${d.device ?? null},
          ${d.hw_concurrency ?? null}, ${d.dpr ?? null},
          ${d.viewport_w ?? null}, ${d.viewport_h ?? null},
          ${d.overlay_count ?? null}, ${d.panes ?? null}, ${d.canvas_px ?? null},
          ${d.gpu ?? null}, ${d.probe_ms ?? null},
          ${d.fps ?? null}, ${d.frame_p50_ms ?? null}, ${d.frame_p95_ms ?? null},
          ${d.frame_worst_ms ?? null}, ${d.long_tasks ?? null}, ${d.long_busy_pct ?? null},
          -- The wind blob is passed as the OBJECT, with no ::jsonb cast:
          -- postgres.js serialises objects to JSON itself, and a
          -- pre-stringified value re-stringified through a cast comes
          -- back as a jsonb STRING containing JSON — which reads as
          -- typeof string and makes (wind ? 'on') false for every row,
          -- i.e. the whole group=wind split silently reports "off".
          ${d.wind ?? null},
          ${d.dot_px_per_s ?? null}, ${d.dcl_ms ?? null}, ${d.load_ms ?? null},
          ${d.view ?? null}
        )
        ON CONFLICT (day, session_id, phase) DO UPDATE SET
          browser = EXCLUDED.browser, os = EXCLUDED.os, device = EXCLUDED.device,
          hw_concurrency = EXCLUDED.hw_concurrency, dpr = EXCLUDED.dpr,
          viewport_w = EXCLUDED.viewport_w, viewport_h = EXCLUDED.viewport_h,
          overlay_count = EXCLUDED.overlay_count, panes = EXCLUDED.panes,
          canvas_px = EXCLUDED.canvas_px, gpu = EXCLUDED.gpu, probe_ms = EXCLUDED.probe_ms,
          fps = EXCLUDED.fps, frame_p50_ms = EXCLUDED.frame_p50_ms,
          frame_p95_ms = EXCLUDED.frame_p95_ms, frame_worst_ms = EXCLUDED.frame_worst_ms,
          long_tasks = EXCLUDED.long_tasks, long_busy_pct = EXCLUDED.long_busy_pct,
          wind = EXCLUDED.wind, dot_px_per_s = EXCLUDED.dot_px_per_s,
          dcl_ms = EXCLUDED.dcl_ms, load_ms = EXCLUDED.load_ms, view = EXCLUDED.view,
          reported_at = now()`;
    } catch (err) {
      // A missing table (migration not applied yet) or a write failure
      // must never reach the reader — telemetry is a footnote on the
      // map, never a feature of it. `console.error` is deliberate here:
      // unlike the reader-facing XLog, this one has to show up in the
      // service log or nobody notices the table is gone.
      console.error("[client-perf] write failed:", err);
      return c.json({ ok: false }, 500);
    }
    return c.json({ ok: true });
  },
);

// ── GET /api/analytics/perf ─────────────────────────────────────────────
// The study the owner asked for: how slow is it, on whose machine, and
// why. Grouped by one column at a time — `browser` answers "is Firefox
// really slower on readers' machines", `gpu` answers "does software
// rendering explain it", `overlays` answers "how much does a heavy map
// cost", `wind` answers "does the animation add anything".
//
// The group expression is picked from a fixed switch below, never built
// from the query string: a GROUP BY is not a parameter place.
const PerfQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  phase: z.enum(["settled", "wind"]).default("settled"),
  group: z.enum(["browser", "device", "gpu", "overlays", "wind"]).default("browser"),
});

// The four shapes a report can be bucketed by. `overlays` is bucketed
// rather than exact: the interesting question is "how many", and a
// bucket keeps the cardinality low enough to read.
const GROUP_EXPR: Record<string, string> = {
  browser: `COALESCE(browser, 'unknown')`,
  device: `COALESCE(device, 'unknown')`,
  gpu: `COALESCE(left(gpu, 60), 'unknown')`,
  overlays: `CASE WHEN overlay_count IS NULL THEN 'unknown'
                  WHEN overlay_count <= 2 THEN '0-2'
                  WHEN overlay_count <= 5 THEN '3-5'
                  WHEN overlay_count <= 9 THEN '6-9'
                  WHEN overlay_count <= 14 THEN '10-14'
                  ELSE '15+' END`,
  wind: `CASE WHEN (wind ? 'on') AND (wind->>'on')::boolean THEN 'on' ELSE 'off' END`,
};

analyticsRoute.get(
  "/analytics/perf",
  zValidator("query", PerfQuerySchema),
  async (c) => {
    const q = c.req.valid("query");
    const sql = getDb();
    const since = new Date(Date.now() - q.days * 86400000);
    const grp = GROUP_EXPR[q.group];

    try {
      // Every percentile here is over the SESSIONS of that group, and
      // `fps_p50 < 30` is the number this whole table exists for: the
      // share of readers whose map is not smooth.
      const items = await sql<any[]>`
        SELECT ${sql.unsafe(grp)} AS grp,
               count(*)::int AS reports,
               count(DISTINCT session_id)::int AS sessions,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY fps))::numeric, 1) AS fps_p50,
               round((percentile_cont(0.95) WITHIN GROUP (ORDER BY fps))::numeric, 1) AS fps_p95,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY frame_p95_ms))::numeric, 1) AS frame_p95_p50,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY overlay_count))::numeric, 0) AS overlays_p50,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY dot_px_per_s))::numeric, 1) AS dot_px_per_s_p50,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY probe_ms))::numeric, 2) AS probe_ms_p50,
               round(100.0 * count(*) FILTER (WHERE fps < 30)
                     / NULLIF(count(*) FILTER (WHERE fps IS NOT NULL), 0))::int AS pct_below_30fps,
               round(100.0 * count(*) FILTER (WHERE (wind ? 'on') AND (wind->>'on')::boolean)
                     / NULLIF(count(*), 0))::int AS wind_on_pct
        FROM client_perf
        WHERE day >= ${since} AND phase = ${q.phase}
        GROUP BY 1
        ORDER BY sessions DESC
        LIMIT 60`;

      const totals = await sql<any[]>`
        SELECT count(*)::int AS reports,
               count(DISTINCT session_id)::int AS sessions,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY fps))::numeric, 1) AS fps_p50,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY frame_p95_ms))::numeric, 1) AS frame_p95_p50,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY dot_px_per_s))::numeric, 1) AS dot_px_per_s_p50,
               round(100.0 * count(*) FILTER (WHERE fps < 30)
                     / NULLIF(count(*) FILTER (WHERE fps IS NOT NULL), 0))::int AS pct_below_30fps
        FROM client_perf
        WHERE day >= ${since} AND phase = ${q.phase}`;

      return c.json({
        items: items.map((r) => ({
          group: r.grp,
          reports: r.reports,
          sessions: r.sessions,
          fps_p50: r.fps_p50 === null ? null : Number(r.fps_p50),
          fps_p95: r.fps_p95 === null ? null : Number(r.fps_p95),
          frame_p95_p50: r.frame_p95_p50 === null ? null : Number(r.frame_p95_p50),
          overlays_p50: r.overlays_p50 === null ? null : Number(r.overlays_p50),
          dot_px_per_s_p50: r.dot_px_per_s_p50 === null ? null : Number(r.dot_px_per_s_p50),
          probe_ms_p50: r.probe_ms_p50 === null ? null : Number(r.probe_ms_p50),
          pct_below_30fps: r.pct_below_30fps,
          wind_on_pct: r.wind_on_pct,
        })),
        count: items.length,
        totals: {
          reports: totals[0]?.reports ?? 0,
          sessions: totals[0]?.sessions ?? 0,
          fps_p50: totals[0]?.fps_p50 == null ? null : Number(totals[0].fps_p50),
          frame_p95_p50: totals[0]?.frame_p95_p50 == null ? null : Number(totals[0].frame_p95_p50),
          dot_px_per_s_p50: totals[0]?.dot_px_per_s_p50 == null ? null : Number(totals[0].dot_px_per_s_p50),
          pct_below_30fps: totals[0]?.pct_below_30fps ?? null,
        },
        window_days: q.days,
        phase: q.phase,
        group: q.group,
      });
    } catch (err) {
      // The migration may not have been applied yet — the report is a
      // read, so it answers with an empty one rather than a 500.
      console.error("[client-perf] report failed:", err);
      return c.json({
        items: [], count: 0,
        totals: { reports: 0, sessions: 0 },
        window_days: q.days, phase: q.phase, group: q.group, error: "unavailable",
      });
    }
  },
);
