import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getDb } from "../db";

export const searchIntelRoute = new Hono();

// ── POST /api/search/journey ───────────────────────────────────────────────
// Log an atomic interaction within a search session
const JourneyEventSchema = z.object({
  session_id:       z.string().max(200),
  search_event_id:  z.number().int().positive().optional(),
  event_type:       z.enum([
    'search', 'result_render', 'pin_click', 'popup_open', 'popup_dwell',
    'reformulate', 'clear', 'discovery_shown', 'discovery_click',
    'zoom_in', 'filter_apply', 'time_filter_change',
  ]),
  query:            z.string().max(500).optional(),
  result_count:     z.number().int().min(0).optional(),
  clicked_pin_id:   z.number().int().positive().optional(),
  clicked_event_id: z.number().int().positive().optional(),
  dwell_ms:         z.number().int().min(0).optional(),
  latency_ms:       z.number().int().min(0).optional(),
  recovery_type:    z.enum(['external_discovery','entity_expand','semantic','query_expand']).optional(),
  metadata:         z.record(z.unknown()).optional(),
});

searchIntelRoute.post("/search/journey", zValidator("json", JourneyEventSchema), async (c) => {
  const b = c.req.valid("json");
  const sql = getDb();
  try {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO search_journey_events
        (session_id, search_event_id, event_type, query, result_count,
         clicked_pin_id, clicked_event_id, dwell_ms, latency_ms, recovery_type, metadata)
      VALUES (
        ${b.session_id},
        ${b.search_event_id ?? null},
        ${b.event_type},
        ${b.query ?? null},
        ${b.result_count ?? null},
        ${b.clicked_pin_id ?? null},
        ${b.clicked_event_id ?? null},
        ${b.dwell_ms ?? null},
        ${b.latency_ms ?? null},
        ${b.recovery_type ?? null},
        ${sql.json(b.metadata ?? {})}
      )
      RETURNING id
    `;
    return c.json({ ok: true, id: Number(row.id) });
  } catch (e) {
    console.error("[search-journey] insert failed:", (e as Error).message);
    return c.json({ ok: false, error: "insert_failed" }, 500);
  }
});

// ── POST /api/search/failure ───────────────────────────────────────────────
// Classify and log a search failure
const FailureSchema = z.object({
  session_id:         z.string().max(200),
  search_event_id:    z.number().int().positive().optional(),
  query:              z.string().max(500),
  failure_type:       z.enum([
    'zero_results', 'wrong_location', 'wrong_topic', 'stale_results',
    'low_diversity', 'ranking_failure', 'missing_entity', 'missing_topic',
    'source_gap', 'true_unknown',
  ]),
  confidence:         z.number().min(0).max(1).optional(),
  query_parsed:       z.object({ entity: z.string().optional(), domain: z.string().optional(),
                                  intent: z.string().optional(), time: z.string().optional() }).optional(),
  matched_pins:       z.number().int().min(0).optional(),
  avg_dwell_ms:       z.number().int().min(0).optional(),
  reformulated:       z.boolean().optional(),
  discovery_count:    z.number().int().min(0).optional(),
  discovery_relevant: z.number().int().min(0).optional(),
  recovery_method:    z.enum(['duckduckgo','entity_geocode','semantic_search','query_expand']).optional(),
  recovery_success:  z.boolean().optional(),
  ai_diagnosis:      z.string().max(1000).optional(),
  ai_suggestions:     z.array(z.string()).max(10).optional(),
  pin_views:          z.number().int().min(0).optional(),
  pin_clicks:         z.number().int().min(0).optional(),
  unique_sources_shown: z.number().int().min(0).optional(),
});

searchIntelRoute.post("/search/failure", zValidator("json", FailureSchema), async (c) => {
  const b = c.req.valid("json");
  const sql = getDb();
  try {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO search_failures
        (session_id, search_event_id, query, failure_type, confidence,
         query_parsed, matched_pins, avg_dwell_ms, reformulated,
         discovery_count, discovery_relevant, recovery_method, recovery_success,
         ai_diagnosis, ai_suggestions, pin_views, pin_clicks, unique_sources_shown)
      VALUES (
        ${b.session_id}, ${b.search_event_id ?? null}, ${b.query}, ${b.failure_type},
        ${b.confidence ?? 0.5},
        ${b.query_parsed ? sql.json(b.query_parsed) : sql`NULL`},
        ${b.matched_pins ?? 0}, ${b.avg_dwell_ms ?? null},
        ${b.reformulated ?? null},
        ${b.discovery_count ?? 0}, ${b.discovery_relevant ?? 0},
        ${b.recovery_method ?? null}, ${b.recovery_success ?? null},
        ${b.ai_diagnosis ?? null},
        ${b.ai_suggestions ? sql.array(b.ai_suggestions) : sql`NULL`},
        ${b.pin_views ?? 0}, ${b.pin_clicks ?? 0},
        ${b.unique_sources_shown ?? 0}
      )
      RETURNING id
    `;
    return c.json({ ok: true, id: Number(row.id) });
  } catch (e) {
    console.error("[search-failure] insert failed:", (e as Error).message);
    return c.json({ ok: false, error: "insert_failed" }, 500);
  }
});

// ── POST /api/search/gap ───────────────────────────────────────────────────
// Update gap intelligence (called by background job or after each search)
const GapUpdateSchema = z.object({
  query:           z.string().max(500),
  language:        z.string().max(10).optional(),
  country:         z.string().max(8).optional(),
  domain:          z.string().max(100).optional(),
  intent:          z.string().max(50).optional(),
  entity_type:     z.string().max(50).optional(),
  zero_result:     z.boolean(),
  result_count:    z.number().int().min(0),
  recovered:       z.boolean(),
  recovery_method: z.enum(['duckduckgo','entity_geocode','semantic_search','query_expand']).optional(),
});

searchIntelRoute.post("/search/gap", zValidator("json", GapUpdateSchema), async (c) => {
  const b = c.req.valid("json");
  const sql = getDb();

  // Normalize query to cluster key
  const normalized = b.query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).filter(w => w.length > 2).sort().join(' ');
  const fingerprint = normalized; // for now, use sorted trigrams as fingerprint

  try {
    await sql`
      INSERT INTO xyzo_search_gaps
        (query_cluster, query_fingerprint, language, country, domain, intent,
         entity_type, search_count, unique_sessions, zero_result_count,
         soft_fail_count, searches_7d, searches_30d,
         failure_breakdown, avg_result_count, recovery_rate, last_seen)
      VALUES (
        ${b.query.slice(0, 200)}, ${fingerprint}, ${b.language ?? null},
        ${b.country ?? null}, ${b.domain ?? null}, ${b.intent ?? null},
        ${b.entity_type ?? null},
        1, 1,
        ${b.zero_result ? 1 : 0},
        ${(!b.zero_result && b.result_count < 5) ? 1 : 0},
        ${b.zero_result ? 1 : 0}, ${b.zero_result ? 1 : 0},
        ${sql.json(b.zero_result ? { zero_results: 1 } : { soft_fail: 1 })},
        ${b.result_count},
        ${b.recovered ? 1.0 : 0.0},
        NOW()
      )
      ON CONFLICT (query_fingerprint) DO UPDATE SET
        search_count      = xyzo_search_gaps.search_count + 1,
        unique_sessions   = xyzo_search_gaps.unique_sessions + 1,
        zero_result_count = xyzo_search_gaps.zero_result_count + ${b.zero_result ? 1 : 0},
        soft_fail_count   = xyzo_search_gaps.soft_fail_count + ${(!b.zero_result && b.result_count < 5) ? 1 : 0},
        last_seen         = NOW(),
        avg_result_count  = (xyzo_search_gaps.avg_result_count * xyzo_search_gaps.search_count + ${b.result_count})
                             / (xyzo_search_gaps.search_count + 1),
        recovery_rate      = CASE WHEN ${b.recovered}
                             THEN (xyzo_search_gaps.recovery_rate * xyzo_search_gaps.search_count + 1.0)
                                / (xyzo_search_gaps.search_count + 1)
                             ELSE xyzo_search_gaps.recovery_rate
                         END
    `;
    return c.json({ ok: true });
  } catch (e) {
    console.error("[search-gap] upsert failed:", (e as Error).message);
    return c.json({ ok: false, error: "upsert_failed" }, 500);
  }
});

// ── GET /api/search/gaps ───────────────────────────────────────────────────
// Returns top opportunity gaps for the dashboard
searchIntelRoute.get("/search/gaps", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
  const sql = getDb();
  try {
    const rows = await sql<any[]>`
      SELECT
        gap_id, query_cluster, domain, intent,
        search_count, zero_result_count, soft_fail_count,
        growth_rate,
        ROUND(zero_result_count::float / NULLIF(search_count, 0) * 100, 1) AS zero_rate_pct,
        ROUND(recovery_rate * 100, 1) AS recovery_pct,
        avg_result_count,
        related_entities, related_topics,
        first_seen, last_seen,
        importance_score
      FROM xyzo_search_gaps
      WHERE search_count >= 3
      ORDER BY
        (zero_result_count + soft_fail_count) * (1 + growth_rate) DESC,
        search_count DESC
      LIMIT ${limit}
    `;
    return c.json({ gaps: rows, count: rows.length });
  } catch (e) {
    console.error("[search-gaps] select failed:", (e as Error).message);
    return c.json({ error: "query_failed" }, 500);
  }
});
