import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { RateLimiter, getClientIp } from "../ratelimit";
import { getDb } from "../db";

export const problemsRoute = new Hono();

const problemsLimiter = new RateLimiter({ max: 60, windowMs: 60 * 1000 });

const ProblemsQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
  status: z.enum(["active", "monitoring", "resolved", "dismissed"]).optional(),
  type: z.enum(["recurring", "emerging", "worsening"]).optional(),
  country: z.string().max(50).optional(),
  min_severity: z.coerce.number().min(0).max(1).optional(),
  sort: z.enum(["severity", "urgency", "recent", "count"]).default("severity"),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radius: z.coerce.number().min(1).max(5000).default(300).optional(),
});

// GET /api/problems/stats — summary stats (MUST be before /:id)
problemsRoute.get("/problems/stats", async (c) => {
  const sql = getDb();

  const [total, by_type, by_status, top_severity] = await Promise.all([
    sql`SELECT COUNT(*) FROM news_problems WHERE status = 'active'`,
    sql`SELECT problem_type, COUNT(*) FROM news_problems WHERE status = 'active' GROUP BY problem_type ORDER BY COUNT(*) DESC`,
    sql`SELECT status, COUNT(*) FROM news_problems GROUP BY status ORDER BY COUNT(*) DESC`,
    sql`SELECT AVG(severity) AS avg_severity, AVG(urgency) AS avg_urgency, SUM(occurrence_count) AS total_events FROM news_problems WHERE status = 'active'`,
  ]);

  return c.json({
    active_problems: Number(total[0]?.count ?? 0),
    by_type: Object.fromEntries(
      (by_type as Array<{ problem_type: string; count: bigint }>).map(r => [r.problem_type, Number(r.count)])
    ),
    by_status: Object.fromEntries(
      (by_status as Array<{ status: string; count: bigint }>).map(r => [r.status, Number(r.count)])
    ),
    avg_severity: Math.round((top_severity[0]?.avg_severity ?? 0) * 100) / 100,
    avg_urgency: Math.round((top_severity[0]?.avg_urgency ?? 0) * 100) / 100,
    total_events_covered: Number(top_severity[0]?.total_events ?? 0),
  });
});

// GET /api/problems — list problems
problemsRoute.get("/problems", zValidator("query", ProblemsQuerySchema), async (c) => {
  const ip = getClientIp(c.req.raw);
  const rl = problemsLimiter.check(ip);
  if (!rl.allowed) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const q = c.req.valid("query");
  const sql = getDb();

  let rows: any[];
  let countResult: any[];

  const hasGeo = Number.isFinite(q.lat) && Number.isFinite(q.lng);
  const lat = q.lat ?? 0;
  const lng = q.lng ?? 0;
  const radiusKm = q.radius ?? 300;
  const latDelta = radiusKm / 111.0;
  const lngDelta = radiusKm / (111.0 * Math.cos(lat * Math.PI / 180));
  const geoFilter = hasGeo
    ? sql` AND l.lat BETWEEN ${lat - latDelta} AND ${lat + latDelta} AND l.lng BETWEEN ${lng - lngDelta} AND ${lng + lngDelta}`
    : sql``;
  const countGeoJoin = hasGeo ? sql` LEFT JOIN news_locations l ON l.id = p.location_id` : sql``;

  if (q.status) {
    if (q.sort === "severity") {
      [rows, countResult] = await Promise.all([
        sql`SELECT p.id, p.problem_key, p.event_type, p.headline, p.description, p.country_code, p.problem_type, p.severity, p.urgency, p.occurrence_count, p.first_detected, p.last_occurrence, p.status, p.confidence, p.updated_at, l.place_name AS location_name, l.lat AS location_lat, l.lng AS location_lng, COALESCE(e.linked_events, 0) AS linked_event_count FROM news_problems p LEFT JOIN news_locations l ON l.id = p.location_id LEFT JOIN LATERAL (SELECT COUNT(*) AS linked_events FROM news_problem_events pe WHERE pe.problem_id = p.id) e ON true WHERE p.status = ${q.status}${geoFilter} ORDER BY p.severity DESC LIMIT ${q.limit} OFFSET ${q.offset}`,
        sql`SELECT COUNT(*) FROM news_problems p ${countGeoJoin} WHERE p.status = ${q.status}${geoFilter}`,
      ]);
    } else if (q.sort === "urgency") {
      [rows, countResult] = await Promise.all([
        sql`SELECT p.id, p.problem_key, p.event_type, p.headline, p.description, p.country_code, p.problem_type, p.severity, p.urgency, p.occurrence_count, p.first_detected, p.last_occurrence, p.status, p.confidence, p.updated_at, l.place_name AS location_name, l.lat AS location_lat, l.lng AS location_lng, COALESCE(e.linked_events, 0) AS linked_event_count FROM news_problems p LEFT JOIN news_locations l ON l.id = p.location_id LEFT JOIN LATERAL (SELECT COUNT(*) AS linked_events FROM news_problem_events pe WHERE pe.problem_id = p.id) e ON true WHERE p.status = ${q.status}${geoFilter} ORDER BY p.urgency DESC LIMIT ${q.limit} OFFSET ${q.offset}`,
        sql`SELECT COUNT(*) FROM news_problems p ${countGeoJoin} WHERE p.status = ${q.status}${geoFilter}`,
      ]);
    } else if (q.sort === "recent") {
      [rows, countResult] = await Promise.all([
        sql`SELECT p.id, p.problem_key, p.event_type, p.headline, p.description, p.country_code, p.problem_type, p.severity, p.urgency, p.occurrence_count, p.first_detected, p.last_occurrence, p.status, p.confidence, p.updated_at, l.place_name AS location_name, l.lat AS location_lat, l.lng AS location_lng, COALESCE(e.linked_events, 0) AS linked_event_count FROM news_problems p LEFT JOIN news_locations l ON l.id = p.location_id LEFT JOIN LATERAL (SELECT COUNT(*) AS linked_events FROM news_problem_events pe WHERE pe.problem_id = p.id) e ON true WHERE p.status = ${q.status}${geoFilter} ORDER BY p.last_occurrence DESC LIMIT ${q.limit} OFFSET ${q.offset}`,
        sql`SELECT COUNT(*) FROM news_problems p ${countGeoJoin} WHERE p.status = ${q.status}${geoFilter}`,
      ]);
    } else {
      [rows, countResult] = await Promise.all([
        sql`SELECT p.id, p.problem_key, p.event_type, p.headline, p.description, p.country_code, p.problem_type, p.severity, p.urgency, p.occurrence_count, p.first_detected, p.last_occurrence, p.status, p.confidence, p.updated_at, l.place_name AS location_name, l.lat AS location_lat, l.lng AS location_lng, COALESCE(e.linked_events, 0) AS linked_event_count FROM news_problems p LEFT JOIN news_locations l ON l.id = p.location_id LEFT JOIN LATERAL (SELECT COUNT(*) AS linked_events FROM news_problem_events pe WHERE pe.problem_id = p.id) e ON true WHERE p.status = ${q.status}${geoFilter} ORDER BY p.occurrence_count DESC LIMIT ${q.limit} OFFSET ${q.offset}`,
        sql`SELECT COUNT(*) FROM news_problems p ${countGeoJoin} WHERE p.status = ${q.status}${geoFilter}`,
      ]);
    }
  } else {
    if (q.sort === "severity") {
      [rows, countResult] = await Promise.all([
        sql`SELECT p.id, p.problem_key, p.event_type, p.headline, p.description, p.country_code, p.problem_type, p.severity, p.urgency, p.occurrence_count, p.first_detected, p.last_occurrence, p.status, p.confidence, p.updated_at, l.place_name AS location_name, l.lat AS location_lat, l.lng AS location_lng, COALESCE(e.linked_events, 0) AS linked_event_count FROM news_problems p LEFT JOIN news_locations l ON l.id = p.location_id LEFT JOIN LATERAL (SELECT COUNT(*) AS linked_events FROM news_problem_events pe WHERE pe.problem_id = p.id) e ON true WHERE 1=1${geoFilter} ORDER BY p.severity DESC LIMIT ${q.limit} OFFSET ${q.offset}`,
        sql`SELECT COUNT(*) FROM news_problems p ${countGeoJoin} WHERE 1=1${geoFilter}`,
      ]);
    } else if (q.sort === "urgency") {
      [rows, countResult] = await Promise.all([
        sql`SELECT p.id, p.problem_key, p.event_type, p.headline, p.description, p.country_code, p.problem_type, p.severity, p.urgency, p.occurrence_count, p.first_detected, p.last_occurrence, p.status, p.confidence, p.updated_at, l.place_name AS location_name, l.lat AS location_lat, l.lng AS location_lng, COALESCE(e.linked_events, 0) AS linked_event_count FROM news_problems p LEFT JOIN news_locations l ON l.id = p.location_id LEFT JOIN LATERAL (SELECT COUNT(*) AS linked_events FROM news_problem_events pe WHERE pe.problem_id = p.id) e ON true WHERE 1=1${geoFilter} ORDER BY p.urgency DESC LIMIT ${q.limit} OFFSET ${q.offset}`,
        sql`SELECT COUNT(*) FROM news_problems p ${countGeoJoin} WHERE 1=1${geoFilter}`,
      ]);
    } else if (q.sort === "recent") {
      [rows, countResult] = await Promise.all([
        sql`SELECT p.id, p.problem_key, p.event_type, p.headline, p.description, p.country_code, p.problem_type, p.severity, p.urgency, p.occurrence_count, p.first_detected, p.last_occurrence, p.status, p.confidence, p.updated_at, l.place_name AS location_name, l.lat AS location_lat, l.lng AS location_lng, COALESCE(e.linked_events, 0) AS linked_event_count FROM news_problems p LEFT JOIN news_locations l ON l.id = p.location_id LEFT JOIN LATERAL (SELECT COUNT(*) AS linked_events FROM news_problem_events pe WHERE pe.problem_id = p.id) e ON true WHERE 1=1${geoFilter} ORDER BY p.last_occurrence DESC LIMIT ${q.limit} OFFSET ${q.offset}`,
        sql`SELECT COUNT(*) FROM news_problems p ${countGeoJoin} WHERE 1=1${geoFilter}`,
      ]);
    } else {
      [rows, countResult] = await Promise.all([
        sql`SELECT p.id, p.problem_key, p.event_type, p.headline, p.description, p.country_code, p.problem_type, p.severity, p.urgency, p.occurrence_count, p.first_detected, p.last_occurrence, p.status, p.confidence, p.updated_at, l.place_name AS location_name, l.lat AS location_lat, l.lng AS location_lng, COALESCE(e.linked_events, 0) AS linked_event_count FROM news_problems p LEFT JOIN news_locations l ON l.id = p.location_id LEFT JOIN LATERAL (SELECT COUNT(*) AS linked_events FROM news_problem_events pe WHERE pe.problem_id = p.id) e ON true WHERE 1=1${geoFilter} ORDER BY p.occurrence_count DESC LIMIT ${q.limit} OFFSET ${q.offset}`,
        sql`SELECT COUNT(*) FROM news_problems p ${countGeoJoin} WHERE 1=1${geoFilter}`,
      ]);
    }
  }

  const total = Number((countResult[0]?.count ?? 0));

  const problems = (rows as Array<Record<string, unknown>>).map(r => ({
    id: Number(r.id),
    problem_key: r.problem_key,
    event_type: r.event_type,
    headline: r.headline,
    description: r.description,
    country_code: r.country_code,
    problem_type: r.problem_type,
    severity: Math.round(Number(r.severity) * 100) / 100,
    urgency: Math.round(Number(r.urgency) * 100) / 100,
    occurrence_count: Number(r.occurrence_count),
    first_detected: r.first_detected,
    last_occurrence: r.last_occurrence,
    status: r.status,
    confidence: Math.round(Number(r.confidence) * 100) / 100,
    location_name: r.location_name,
    location_lat: r.location_lat != null ? Number(r.location_lat) : null,
    location_lng: r.location_lng != null ? Number(r.location_lng) : null,
    linked_event_count: Number(r.linked_event_count ?? 0),
    updated_at: r.updated_at,
  }));

  return c.json({
    items: problems,
    count: total,
    limit: q.limit,
    offset: q.offset,
  });
});

// GET /api/problems/:id — single problem with actions
problemsRoute.get("/problems/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id) return c.json({ error: "invalid_id" }, 400);

  const sql = getDb();

  const [problem_row, actions_rows] = await Promise.all([
    sql`
      SELECT
        p.id, p.problem_key, p.event_type, p.headline, p.description,
        p.country_code, p.problem_type, p.severity, p.urgency,
        p.occurrence_count, p.first_detected, p.last_occurrence,
        p.status, p.confidence, p.metadata, p.created_at, p.updated_at,
        l.id AS location_id, l.place_name AS location_name,
        l.lat AS location_lat, l.lng AS location_lng
      FROM news_problems p
      LEFT JOIN news_locations l ON l.id = p.location_id
      WHERE p.id = ${id}
    `,
    sql`
      SELECT
        id, problem_id, action_key, headline, description,
        who_can_do, expected_benefit, risks, confidence,
        time_horizon, status, created_at
      FROM news_problem_actions
      WHERE problem_id = ${id}
      ORDER BY confidence DESC
    `,
  ]);

  if (!problem_row.length) {
    return c.json({ error: "not_found" }, 404);
  }

  const r = problem_row[0] as Record<string, unknown>;
  const actions = (actions_rows as Array<Record<string, unknown>>).map(a => ({
    id: Number(a.id),
    problem_id: Number(a.problem_id),
    action_key: a.action_key,
    headline: a.headline,
    description: a.description,
    who_can_do: a.who_can_do ?? [],
    expected_benefit: a.expected_benefit,
    risks: a.risks,
    confidence: Math.round(((a.confidence as number) ?? 0.5) * 100) / 100,
    time_horizon: a.time_horizon,
    status: a.status,
    created_at: a.created_at,
  }));

  return c.json({
    problem: {
      id: Number(r.id),
      problem_key: r.problem_key,
      event_type: r.event_type,
      headline: r.headline,
      description: r.description,
      country_code: r.country_code,
      problem_type: r.problem_type,
      severity: Math.round((r.severity as number) * 100) / 100,
      urgency: Math.round((r.urgency as number) * 100) / 100,
      occurrence_count: r.occurrence_count,
      first_detected: r.first_detected,
      last_occurrence: r.last_occurrence,
      status: r.status,
      confidence: Math.round((r.confidence as number) * 100) / 100,
      location: r.location_id ? {
        id: Number(r.location_id),
        name: r.location_name,
        lat: Number(r.location_lat),
        lng: Number(r.location_lng),
      } : null,
      metadata: r.metadata ?? {},
      created_at: r.created_at,
      updated_at: r.updated_at,
    },
    actions,
  });
});

// POST /api/problems/:id/actions/:actionId/approve — human approval for action
problemsRoute.post(
  "/problems/:id/actions/:actionId/approve",
  zValidator("json", z.object({ approved: z.boolean() })),
  async (c) => {
    const problemId = Number(c.req.param("id"));
    const actionId = Number(c.req.param("actionId"));
    const { approved } = c.req.valid("json");

    if (!problemId || !actionId) {
      return c.json({ error: "invalid_id" }, 400);
    }

    const sql = getDb();
    const status = approved ? "approved" : "rejected";
    const now = new Date().toISOString();

    await sql`
      UPDATE news_problem_actions
      SET approval_status = ${status}, approved_at = ${now}, updated_at = ${now}
      WHERE id = ${actionId} AND problem_id = ${problemId}
    `;

    return c.json({ ok: true, status, approved_at: now });
  }
);
