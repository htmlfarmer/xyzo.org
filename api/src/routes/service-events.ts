// /api/service-events — record and retrieve service restart/deployment events.
// Used by the help page to show a "System Restarts" timeline and by
// automated scripts to log deployments/restarts.
//
// GET  /api/service-events          — public, list recent events (summary only)
// POST /api/service-events          — admin, record a new event
// GET  /api/service-events/:id      — public, single event details

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb } from "../db";
import { adminAuth } from "../auth";

export const serviceEventsRoute = new Hono();

// Schema for recording a new event
const RecordEventSchema = z.object({
  service_name: z.string().min(1),
  event_type: z.enum(["restart", "deploy", "config_change", "source_sync"]),
  reason: z.string().optional(),
  changed_files: z.array(z.string()).optional(),
  details: z.record(z.unknown()).optional(),
  created_by: z.string().optional(),
});

const LIST_LIMIT = 50;

// GET /api/service-events — public list of recent events
serviceEventsRoute.get("/service-events", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? String(LIST_LIMIT)), LIST_LIMIT);
  const offset = parseInt(c.req.query("offset") ?? "0");
  const serviceName = c.req.query("service");
  const eventType = c.req.query("type");

  const sql = getDb();

  const rows = await sql`
    SELECT
      id,
      service_name,
      event_type,
      triggered_at,
      git_branch,
      git_message,
      reason,
      changed_files,
      created_by
    FROM service_events
    WHERE 1=1
      ${serviceName ? sql`AND service_name = ${serviceName}` : sql``}
      ${eventType ? sql`AND event_type = ${eventType}` : sql``}
    ORDER BY triggered_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  const [{ count }] = await sql<[{ count: string }]>`
    SELECT COUNT(*) AS count FROM service_events
    WHERE 1=1
      ${serviceName ? sql`AND service_name = ${serviceName}` : sql``}
      ${eventType ? sql`AND event_type = ${eventType}` : sql``}
  `;

  return c.json({
    items: rows.map((r) => ({
      id: Number(r.id),
      service_name: r.service_name,
      event_type: r.event_type,
      triggered_at: r.triggered_at,
      git_branch: r.git_branch,
      git_message: r.git_message,
      reason: r.reason,
      changed_files: r.changed_files,
      created_by: r.created_by,
    })),
    count: parseInt(count),
    limit,
    offset,
  });
});

// GET /api/service-events/:id — single event
// Use a regex-constrained :id so this catch-all doesn't shadow other
// top-level routes that happen to have a non-numeric segment (e.g.
// `/api/version`, `/api/health`).  Without {[0-9]+}, Hono matches
// `/api/version` as :id="version", parseInt("version") returns NaN,
// and the route returns 400 invalid_id — masking the real route.
//
// Pattern is the same as src/routes/story-links.ts:83.
serviceEventsRoute.get("/:id{[0-9]+}", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "invalid_id" }, 400);

  const sql = getDb();
  const [row] = await sql`
    SELECT
      id,
      service_name,
      event_type,
      triggered_at,
      git_sha_before,
      git_sha_after,
      git_branch,
      git_message,
      reason,
      changed_files,
      details,
      created_by
    FROM service_events
    WHERE id = ${id}
  `;

  if (!row) return c.json({ error: "not_found" }, 404);

  return c.json({ item: { ...row, id: Number(row.id) } });
});

// POST /api/service-events — admin only, record a new event
serviceEventsRoute.post("/service-events", zValidator("json", RecordEventSchema), async (c) => {
  const gate = await adminAuth(c, ["super", "editorial"]);
  if (!gate.ok) return gate.response;

  const data = c.req.valid("json");
  const sql = getDb();

  const [row] = await sql`
    INSERT INTO service_events (
      service_name,
      event_type,
      git_sha_after,
      git_branch,
      git_message,
      reason,
      changed_files,
      details,
      created_by
    ) VALUES (
      ${data.service_name},
      ${data.event_type},
      ${data.details?.["git_sha_after"] as string ?? null},
      ${data.details?.["git_branch"] as string ?? null},
      ${data.details?.["git_message"] as string ?? null},
      ${data.reason ?? null},
      ${data.changed_files ?? null},
      ${data.details ? JSON.stringify(data.details) : null},
      ${data.created_by ?? gate.name ?? "admin"}
    )
    RETURNING
      id,
      service_name,
      event_type,
      triggered_at,
      git_branch,
      git_message,
      reason,
      changed_files,
      created_by
  `;

  return c.json({ ok: true, item: { ...row, id: Number(row.id) } }, 201);
});
