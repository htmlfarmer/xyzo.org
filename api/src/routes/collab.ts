/**
 * Collab network — the API side of `curl | bash` collaborator onboarding.
 *
 * PR-1 scope:
 *   - register a node (issues node_id + dashboard_token)
 *   - heartbeat (per-node liveness + metrics)
 *   - jobs queue (queue, claim, result) for `scripts` mode
 *   - public dashboards (list nodes, show one node)
 *
 * PR-2/3/4 will add gateway registration (hivv.org), model_serve
 * endpoint registration, blnq.org content submission, discovery,
 * and self-improve. They share this route file via more endpoints.
 *
 * Auth model:
 *   - Public reads (GET /api/collab/jobs, /nodes, /node/:id) — no auth.
 *   - Writes (register, heartbeat, claim, result) — require a per-node
 *     `dashboard_token` sent as `Authorization: Bearer <token>`.
 *   - Submitting jobs (POST /api/collab/jobs) — admin auth (super role).
 *     Used by xyzo/blnq/hivv internal pipelines.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import crypto from "node:crypto";
import { getDb } from "../db.js";
import { getClientIp, RateLimiter } from "../ratelimit.js";
import { adminAuth } from "../auth";

export const collabRoute = new Hono();

// Rate limiters (per-IP)
const registerLimiter = new RateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
const heartbeatLimiter = new RateLimiter({ max: 120, windowMs: 60 * 60 * 1000 });
const jobsLimiter = new RateLimiter({ max: 600, windowMs: 60 * 60 * 1000 });

// Public-ish reads don't need rate limit beyond what Caddy already does.

// ── helpers ────────────────────────────────────────────────────────────

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"; // RFC 4648 lowercase

/** 12-char lowercase base32 identifier (60 bits). */
function newNodeId(): string {
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 12; i++) {
    out += BASE32_ALPHABET[bytes[i % 8] % 32];
  }
  return out;
}

/** 32-char URL-safe token (192 bits of entropy). */
function newDashboardToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Verify Authorization: Bearer <token> matches the row's dashboard_token. */
async function requireNodeAuth(
  c: any,
  sql: any,
  nodeId: string,
): Promise<{ ok: true; row: any } | { ok: false; status: 401 | 404; body: any }> {
  const auth = c.req.header("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return { ok: false, status: 401, body: { error: "missing_bearer" } };
  const token = m[1].trim();
  const rows = await sql<any[]>`
    SELECT id, node_id, name, roles, status, dashboard_token
    FROM collab_nodes
    WHERE node_id = ${nodeId}
    LIMIT 1
  `;
  if (rows.length === 0) return { ok: false, status: 404, body: { error: "node_not_found" } };
  const row = rows[0];
  // Constant-time compare.
  const a = Buffer.from(token);
  const b = Buffer.from(row.dashboard_token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, body: { error: "bad_token" } };
  }
  return { ok: true, row };
}

// ── schemas ────────────────────────────────────────────────────────────

const RegisterSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  public_key: z.string().min(100).max(8192), // PEM, ~450 bytes for 2048-bit
  os: z.enum(["macos", "linux", "wsl", "windows", "other"]),
  arch: z.enum(["arm64", "x86_64", "other"]),
  python_version: z.string().max(20).optional(),
  collabd_version: z.string().max(40).optional(),
  roles: z.array(z.enum(["scripts", "gateway", "model_serve", "content"]))
    .min(1).max(4).default(["scripts"]),
});

const HeartbeatSchema = z.object({
  uptime_s: z.number().int().nonnegative().optional(),
  jobs_done: z.number().int().nonnegative().optional(),
  jobs_failed: z.number().int().nonnegative().optional(),
  modes_active: z.array(z.string()).max(10).optional(),
  collabd_version: z.string().max(40).optional(),
  extra: z.record(z.string(), z.any()).optional(),
});

const SubmitJobSchema = z.object({
  kind: z.enum(["shell", "ai_extract", "classify"]).default("shell"),
  payload: z.record(z.string(), z.any()),
  priority: z.number().int().min(0).max(1000).default(100),
  source: z.enum(["xyzo", "blnq", "hivv", "manual"]).default("manual"),
  timeout_seconds: z.number().int().min(5).max(3600).default(300),
});

const ResultSchema = z.object({
  node_id: z.string().min(1).max(20), // echoed; cross-checked with token
  exit_code: z.number().int().nullable(),
  stdout: z.string().max(1_000_000).optional(), // 1MB cap
  stderr: z.string().max(1_000_000).optional(),
  duration_ms: z.number().int().nonnegative(),
  error_message: z.string().max(2000).optional(),
});

// ── routes ─────────────────────────────────────────────────────────────

/**
 * POST /api/collab/register — public, rate-limited.
 *
 * Body: {name?, public_key, os, arch, python_version?, collabd_version?, roles?}
 * 201:  {node_id, dashboard_token, jobs_url, heartbeat_url, dashboard_url}
 *
 * The returned dashboard_token is the only auth needed for the node's
 * subsequent writes. We display it once and never again — collaborators
 * should back it up via `collab status`.
 */
collabRoute.post("/collab/register", zValidator("json", RegisterSchema), async (c) => {
  const ip = getClientIp(c.req.raw);
  const rl = registerLimiter.check(ip);
  if (!rl.allowed) return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);

  const data = c.req.valid("json");
  const sql = getDb();

  // Reject malformed PEM up-front (don't store junk).
  if (!/-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----/.test(data.public_key)) {
    return c.json({ error: "public_key_must_be_pem" }, 400);
  }

  const nodeId = newNodeId();
  const token = newDashboardToken();
  const name = data.name || `node-${nodeId}`;

  try {
    await sql`
      INSERT INTO collab_nodes
        (node_id, name, public_key, roles, os, arch, python_version, collabd_version, status, dashboard_token)
      VALUES
        (${nodeId}, ${name}, ${data.public_key}, ${data.roles}, ${data.os}, ${data.arch},
         ${data.python_version ?? null}, ${data.collabd_version ?? null},
         'active', ${token})
    `;
  } catch (e: any) {
    // Collision on node_id is extraordinarily unlikely (~1 in 2^60). Surface it.
    if (e?.code === "23505") return c.json({ error: "node_id_collision_retry" }, 503);
    throw e;
  }

  await sql`
    INSERT INTO collab_activity (node_id, action, detail)
    VALUES (${nodeId}, 'register', ${JSON.stringify({ ip, os: data.os, arch: data.arch, roles: data.roles })}::jsonb)
  `;

  return c.json({
    node_id: nodeId,
    dashboard_token: token,
    name,
    jobs_url: `/api/collab/jobs`,
    heartbeat_url: `/api/collab/${nodeId}/heartbeat`,
    dashboard_url: `/collab/node/${nodeId}`,
    roles: data.roles,
  }, 201);
});

/**
 * POST /api/collab/:node_id/heartbeat — bearer auth, rate-limited.
 *
 * Body: {uptime_s?, jobs_done?, jobs_failed?, modes_active?, collabd_version?, extra?}
 * 200:  {ok: true, next_heartbeat_s: 30}
 *
 * Also records an activity row so the per-node timeline can show liveness.
 */
collabRoute.post("/collab/:node_id/heartbeat", zValidator("json", HeartbeatSchema), async (c) => {
  const nodeId = c.req.param("node_id");
  if (!/^[a-z2-7]{12}$/.test(nodeId)) return c.json({ error: "bad_node_id" }, 400);

  const ip = getClientIp(c.req.raw);
  const rl = heartbeatLimiter.check(`${ip}:${nodeId}`);
  if (!rl.allowed) return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);

  const sql = getDb();
  const auth = await requireNodeAuth(c, sql, nodeId);
  if (!auth.ok) return c.json(auth.body, auth.status);

  const data = c.req.valid("json");
  const meta = {
    uptime_s: data.uptime_s ?? null,
    jobs_done: data.jobs_done ?? null,
    jobs_failed: data.jobs_failed ?? null,
    modes_active: data.modes_active ?? null,
    extra: data.extra ?? null,
  };

  await sql`
    UPDATE collab_nodes
    SET last_heartbeat_at = now(),
        last_heartbeat_meta = ${JSON.stringify(meta)}::jsonb,
        collabd_version = COALESCE(${data.collabd_version ?? null}, collabd_version),
        status = 'active'
    WHERE node_id = ${nodeId}
  `;

  // Only log every 5th heartbeat to avoid activity-table bloat.
  const countRow = await sql<any[]>`
    SELECT COUNT(*)::int AS n FROM collab_activity
    WHERE node_id = ${nodeId} AND action = 'heartbeat'
      AND created_at > now() - INTERVAL '5 minutes'
  `;
  if ((countRow[0]?.n ?? 0) < 1) {
    await sql`
      INSERT INTO collab_activity (node_id, action, detail)
      VALUES (${nodeId}, 'heartbeat', ${JSON.stringify(meta)}::jsonb)
    `;
  }

  return c.json({ ok: true, next_heartbeat_s: 30 });
});

/**
 * GET /api/collab/jobs — public-ish read.
 *
 * Optional: ?node_id=xxx (just for logging).
 * Returns up to 10 queued jobs, priority-sorted. The client picks one and
 * calls /claim on it.
 */
collabRoute.get("/collab/jobs", async (c) => {
  const sql = getDb();
  const limit = Math.min(parseInt(c.req.query("limit") || "10"), 50);
  const rows = await sql<any[]>`
    SELECT id, kind, payload, priority, timeout_seconds, source, created_at
    FROM collab_jobs
    WHERE status = 'queued'
    ORDER BY priority ASC, created_at ASC
    LIMIT ${limit}
  `;
  return c.json({ jobs: rows, server_time: new Date().toISOString() });
});

/**
 * POST /api/collab/jobs/:id/claim — bearer auth.
 *
 * Body: {} (node_id comes from the bearer auth).
 * 200:  {job: {id, kind, payload, timeout_seconds, ...}}
 * 409:  {error: 'already_claimed'} if someone else got it first
 *
 * Atomic via UPDATE...WHERE status='queued' RETURNING — only one claimer wins.
 */
collabRoute.post("/collab/jobs/:id/claim", async (c) => {
  const jobIdRaw = c.req.param("id");
  const jobId = parseInt(jobIdRaw, 10);
  if (!Number.isFinite(jobId) || jobId <= 0) return c.json({ error: "bad_job_id" }, 400);

  const sql = getDb();
  const nodeId = c.req.query("node_id");
  if (!nodeId || !/^[a-z2-7]{12}$/.test(nodeId)) return c.json({ error: "missing_node_id" }, 400);

  const ip = getClientIp(c.req.raw);
  const rl = jobsLimiter.check(`${ip}:${nodeId}`);
  if (!rl.allowed) return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);

  const auth = await requireNodeAuth(c, sql, nodeId);
  if (!auth.ok) return c.json(auth.body, auth.status);

  // Atomic claim.
  const claimed = await sql<any[]>`
    UPDATE collab_jobs
    SET status = 'claimed',
        claimed_by = ${nodeId},
        claimed_at = now()
    WHERE id = ${jobId} AND status = 'queued'
    RETURNING id, kind, payload, priority, timeout_seconds, source, created_at
  `;
  if (claimed.length === 0) {
    return c.json({ error: "already_claimed_or_gone" }, 409);
  }

  await sql`
    INSERT INTO collab_activity (node_id, action, detail)
    VALUES (${nodeId}, 'job_claim', ${JSON.stringify({ job_id: jobId, kind: claimed[0].kind })}::jsonb)
  `;

  return c.json({ job: claimed[0] });
});

/**
 * POST /api/collab/jobs/:id/result — bearer auth.
 *
 * Body: {node_id, exit_code, stdout?, stderr?, duration_ms, error_message?}
 * Marks the job done/failed. Stores stdout/stderr truncated to 1MB.
 */
collabRoute.post("/collab/jobs/:id/result", zValidator("json", ResultSchema), async (c) => {
  const jobId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(jobId) || jobId <= 0) return c.json({ error: "bad_job_id" }, 400);

  const data = c.req.valid("json");
  const sql = getDb();
  const auth = await requireNodeAuth(c, sql, data.node_id);
  if (!auth.ok) return c.json(auth.body, auth.status);

  const ip = getClientIp(c.req.raw);
  const rl = jobsLimiter.check(`${ip}:${data.node_id}`);
  if (!rl.allowed) return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);

  // Verify the job is claimed by this node before letting them write a result.
  const jobRows = await sql<any[]>`
    SELECT status, claimed_by FROM collab_jobs WHERE id = ${jobId} LIMIT 1
  `;
  if (jobRows.length === 0) return c.json({ error: "job_not_found" }, 404);
  const job = jobRows[0];
  if (job.claimed_by !== data.node_id) {
    return c.json({ error: "not_your_job" }, 403);
  }

  const ok = data.exit_code === 0 && !data.error_message;
  const newStatus = ok ? "done" : "failed";
  const result = {
    exit_code: data.exit_code,
    stdout: data.stdout ?? "",
    stderr: data.stderr ?? "",
    duration_ms: data.duration_ms,
    error_message: data.error_message ?? null,
  };

  await sql`
    UPDATE collab_jobs
    SET status = ${newStatus},
        started_at = COALESCE(started_at, now()),
        completed_at = now(),
        result = ${JSON.stringify(result)}::jsonb,
        error_message = ${data.error_message ?? null}
    WHERE id = ${jobId}
  `;

  await sql`
    INSERT INTO collab_activity (node_id, action, detail)
    VALUES (${data.node_id}, ${ok ? "job_done" : "job_failed"}, ${JSON.stringify({ job_id: jobId, exit_code: data.exit_code, duration_ms: data.duration_ms })}::jsonb)
  `;

  return c.json({ ok: true, status: newStatus });
});

// ── internal: submit a job (admin only) ─────────────────────────────────

/**
 * POST /api/collab/jobs — admin auth (super role).
 *
 * Used by xyzo/blnq/hivv internal pipelines to enqueue work.
 * Body: {kind, payload, priority?, source, timeout_seconds?}
 */
collabRoute.post("/collab/jobs", zValidator("json", SubmitJobSchema), async (c) => {
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;

  const data = c.req.valid("json");
  const sql = getDb();
  const rows = await sql<any[]>`
    INSERT INTO collab_jobs (kind, payload, priority, source, timeout_seconds)
    VALUES (${data.kind}, ${JSON.stringify(data.payload)}::jsonb, ${data.priority}, ${data.source}, ${data.timeout_seconds})
    RETURNING id
  `;
  return c.json({ ok: true, job_id: rows[0].id }, 201);
});

// ── public dashboards ──────────────────────────────────────────────────

/** GET /api/collab/nodes — list active nodes for the landing page. */
collabRoute.get("/collab/nodes", async (c) => {
  const sql = getDb();
  const rows = await sql<any[]>`
    SELECT n.node_id, n.name, n.roles, n.os, n.arch, n.collabd_version,
           n.registered_at, n.last_heartbeat_at,
           n.last_heartbeat_meta,
           COALESCE(stats.jobs_done, 0)::int AS jobs_done,
           COALESCE(stats.jobs_failed, 0)::int AS jobs_failed
    FROM collab_nodes n
    LEFT JOIN LATERAL (
      SELECT
        SUM(CASE WHEN action = 'job_done'  THEN 1 ELSE 0 END) AS jobs_done,
        SUM(CASE WHEN action = 'job_failed' THEN 1 ELSE 0 END) AS jobs_failed
      FROM collab_activity a
      WHERE a.node_id = n.node_id
        AND a.created_at > now() - INTERVAL '7 days'
    ) stats ON TRUE
    WHERE n.status = 'active'
    ORDER BY n.last_heartbeat_at DESC NULLS LAST
    LIMIT 200
  `;
  return c.json({ nodes: rows });
});

/** GET /api/collab/node/:id — one node's public profile + recent activity. */
collabRoute.get("/collab/node/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[a-z2-7]{12}$/.test(id)) return c.json({ error: "bad_node_id" }, 400);
  const sql = getDb();
  const nodes = await sql<any[]>`
    SELECT node_id, name, roles, os, arch, collabd_version,
           registered_at, last_heartbeat_at, last_heartbeat_meta, status
    FROM collab_nodes WHERE node_id = ${id} LIMIT 1
  `;
  if (nodes.length === 0) return c.json({ error: "not_found" }, 404);

  const activity = await sql<any[]>`
    SELECT action, detail, created_at
    FROM collab_activity
    WHERE node_id = ${id}
    ORDER BY created_at DESC
    LIMIT 50
  `;

  const stats = await sql<any[]>`
    SELECT
      COUNT(*) FILTER (WHERE action = 'job_done')::int   AS jobs_done,
      COUNT(*) FILTER (WHERE action = 'job_failed')::int AS jobs_failed,
      COUNT(*) FILTER (WHERE action = 'job_claim')::int  AS jobs_claimed,
      COUNT(*)::int AS total_events
    FROM collab_activity
    WHERE node_id = ${id} AND created_at > now() - INTERVAL '7 days'
  `;

  return c.json({
    node: nodes[0],
    activity,
    stats_7d: stats[0],
  });
});
