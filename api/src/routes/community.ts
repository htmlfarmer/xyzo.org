import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb } from "../db";
import { RateLimiter, getClientIp } from "../ratelimit";
import { enqueueOrSpawn } from "../queue/enqueueOrSpawn";
import { adminAuth } from "../auth";

export const communityRoute = new Hono();

// Rate limiter for votes: 30 per hour per IP
const voteLimiter = new RateLimiter({ max: 30, windowMs: 60 * 60 * 1000 });

// ── GET /api/community/requests ─────────────────────────────────────────
//
// List all public location correction requests with vote counts.
// Supports filtering by status, pagination.
communityRoute.get("/community/requests", async (c) => {
  const sql = getDb();
  const status = c.req.query("status") || "all";
  const limit = Math.min(Number(c.req.query("limit") || 50), 200);
  const offset = Number(c.req.query("offset") || 0);

  let whereClause = sql`r.public_visible = TRUE AND r.kind = 'suggest_location'`;
  if (status === "open") {
    whereClause = sql`${whereClause} AND r.community_status = 'open'`;
  } else if (status === "validated") {
    whereClause = sql`${whereClause} AND r.community_status = 'validated'`;
  } else if (status === "rejected") {
    whereClause = sql`${whereClause} AND r.community_status = 'rejected'`;
  } else if (status === "applied") {
    whereClause = sql`${whereClause} AND (r.result->>'applied')::boolean = TRUE`;
  }

  const rows = await sql<any[]>`
    SELECT
      r.id,
      r.pin_id,
      r.article_id,
      r.user_place,
      r.status AS worker_status,
      r.result,
      r.requested_at,
      r.completed_at,
      r.community_status,
      r.confirm_votes,
      r.reject_votes,
      r.map_center_lat,
      r.map_center_lng,
      r.map_zoom,
      a.title AS article_title,
      a.url AS article_url,
      a.location_text AS original_location,
      l.place_name AS original_place_name,
      l.country AS original_country,
      l.lat AS original_lat,
      l.lng AS original_lng,
      (r.result->>'lat')::double precision AS suggested_lat,
      (r.result->>'lng')::double precision AS suggested_lng,
      (r.result->>'place_name') AS suggested_place_name,
      (r.result->>'precision') AS suggested_precision,
      (r.result->>'confidence')::float AS suggested_confidence,
      (r.result->>'applied')::boolean AS was_applied
    FROM news_re_evaluate_requests r
    LEFT JOIN news_articles a ON a.id = r.article_id
    LEFT JOIN news_locations l ON l.id = a.location_id
    WHERE ${whereClause}
    ORDER BY r.requested_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const countRow = await sql<any[]>`
    SELECT COUNT(*) as total
    FROM news_re_evaluate_requests r
    WHERE ${whereClause}
  `;

  // Get status counts for the filter buttons.
  const statusCounts = await sql<any[]>`
    SELECT
      community_status,
      COUNT(*)::int AS n
    FROM news_re_evaluate_requests
    WHERE public_visible = TRUE AND kind = 'suggest_location'
    GROUP BY 1
  `;
  const counts: Record<string, number> = { open: 0, validated: 0, rejected: 0, applied: 0 };
  for (const r of statusCounts) {
    counts[r.community_status] = Number(r.n);
  }

  // Also count applied requests (based on result->>'applied')
  const appliedCount = await sql<any[]>`
    SELECT COUNT(*)::int AS n
    FROM news_re_evaluate_requests
    WHERE public_visible = TRUE AND kind = 'suggest_location'
      AND (result->>'applied')::boolean = TRUE
  `;
  counts.applied = Number(appliedCount[0]?.n || 0);

  // Fetch votes with reasons for all requests in this page.
  const requestIds = rows.map(r => Number(r.id));
  let votesByRequest: Record<number, any[]> = {};
  if (requestIds.length > 0) {
    const votes = await sql<any[]>`
      SELECT request_id, vote, reason, created_at
      FROM news_request_votes
      WHERE request_id = ANY(${requestIds})
        AND reason IS NOT NULL AND reason != ''
      ORDER BY created_at DESC
    `;
    for (const v of votes) {
      const rid = Number(v.request_id);
      if (!votesByRequest[rid]) votesByRequest[rid] = [];
      votesByRequest[rid].push({ vote: v.vote, reason: v.reason });
    }
  }

  return c.json({
    requests: rows.map(r => ({
      id: Number(r.id),
      pin_id: Number(r.pin_id),
      article_id: r.article_id ? Number(r.article_id) : null,
      user_place: r.user_place,
      worker_status: r.worker_status,
      community_status: r.community_status,
      confirm_votes: Number(r.confirm_votes),
      reject_votes: Number(r.reject_votes),
      map_center_lat: r.map_center_lat != null ? Number(r.map_center_lat) : null,
      map_center_lng: r.map_center_lng != null ? Number(r.map_center_lng) : null,
      map_zoom: r.map_zoom != null ? Number(r.map_zoom) : null,
      requested_at: r.requested_at,
      completed_at: r.completed_at,
      article: r.article_title ? {
        title: r.article_title,
        url: r.article_url,
        original_location: r.original_location,
        original_place_name: r.original_place_name,
        original_country: r.original_country,
        original_lat: r.original_lat ? Number(r.original_lat) : null,
        original_lng: r.original_lng ? Number(r.original_lng) : null,
      } : null,
      suggestion: r.suggested_lat != null ? {
        lat: Number(r.suggested_lat),
        lng: Number(r.suggested_lng),
        place_name: r.suggested_place_name,
        precision: r.suggested_precision,
        confidence: r.suggested_confidence ? Number(r.suggested_confidence) : null,
        applied: r.was_applied,
      } : null,
      result: r.result,
      ai_validation: r.result?.ai_validation || null,
      votes_with_reasons: votesByRequest[Number(r.id)] || [],
    })),
    total: Number(countRow[0]?.total || 0),
    counts,
    limit,
    offset,
  });
});

// ── GET /api/community/requests/:id ─────────────────────────────────────
//
// Get a single request with its votes and replies.
communityRoute.get("/community/requests/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "bad_id" }, 400);

  const sql = getDb();

  const rows = await sql<any[]>`
    SELECT
      r.*,
      a.title AS article_title,
      a.url AS article_url,
      a.body AS article_body,
      a.location_text AS original_location,
      l.place_name AS original_place_name,
      l.country AS original_country,
      l.lat AS original_lat,
      l.lng AS original_lng
    FROM news_re_evaluate_requests r
    LEFT JOIN news_articles a ON a.id = r.article_id
    LEFT JOIN news_locations l ON l.id = a.location_id
    WHERE r.id = ${id}
    LIMIT 1
  `;

  if (rows.length === 0) return c.json({ error: "not_found" }, 404);
  const r = rows[0];

  // Get votes
  const votes = await sql<any[]>`
    SELECT vote, reason, created_at
    FROM news_request_votes
    WHERE request_id = ${id}
    ORDER BY created_at DESC
  `;

  // Get replies
  const replies = await sql<any[]>`
    SELECT id, reply_type, reply_text, metadata, created_at
    FROM news_request_replies
    WHERE request_id = ${id}
    ORDER BY created_at ASC
  `;

  return c.json({
    id: Number(r.id),
    pin_id: Number(r.pin_id),
    article_id: r.article_id ? Number(r.article_id) : null,
    kind: r.kind,
    user_place: r.user_place,
    worker_status: r.status,
    community_status: r.community_status,
    confirm_votes: Number(r.confirm_votes),
    reject_votes: Number(r.reject_votes),
    map_center_lat: r.map_center_lat != null ? Number(r.map_center_lat) : null,
    map_center_lng: r.map_center_lng != null ? Number(r.map_center_lng) : null,
    map_zoom: r.map_zoom != null ? Number(r.map_zoom) : null,
    requested_at: r.requested_at,
    started_at: r.started_at,
    completed_at: r.completed_at,
    result: r.result,
    error_message: r.error_message,
    article: r.article_title ? {
      title: r.article_title,
      url: r.article_url,
      body_preview: r.article_body?.slice(0, 500),
      original_location: r.original_location,
      original_place_name: r.original_place_name,
      original_country: r.original_country,
      original_lat: r.original_lat ? Number(r.original_lat) : null,
      original_lng: r.original_lng ? Number(r.original_lng) : null,
    } : null,
    votes: votes.map(v => ({
      vote: v.vote,
      reason: v.reason,
      created_at: v.created_at,
    })),
    replies: replies.map(rp => ({
      id: Number(rp.id),
      type: rp.reply_type,
      text: rp.reply_text,
      metadata: rp.metadata,
      created_at: rp.created_at,
    })),
  });
});

// ── POST /api/community/requests/:id/vote ───────────────────────────────
//
// Vote on a location correction request.
const VoteSchema = z.object({
  vote: z.enum(["confirm", "reject", "needs_info"]),
  reason: z.string().max(500).optional(),
});

communityRoute.post(
  "/community/requests/:id/vote",
  zValidator("json", VoteSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = voteLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
    }

    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) return c.json({ error: "bad_id" }, 400);

    const { vote, reason } = c.req.valid("json");
    const sql = getDb();

    // Check request exists and is open
    const reqRows = await sql<any[]>`
      SELECT id, community_status FROM news_re_evaluate_requests
      WHERE id = ${id} AND public_visible = TRUE
      LIMIT 1
    `;
    if (reqRows.length === 0) return c.json({ error: "not_found" }, 404);
    if (reqRows[0].community_status !== "open") {
      return c.json({ error: "voting_closed", status: reqRows[0].community_status }, 400);
    }

    // Insert or update vote
    const voterIp = ip !== 'unknown' ? ip : '0.0.0.0';
    try {
      await sql`
        INSERT INTO news_request_votes (request_id, voter_ip, vote, reason)
        VALUES (${id}, ${voterIp}::inet, ${vote}, ${reason || null})
        ON CONFLICT (request_id, voter_ip) DO UPDATE SET
          vote = EXCLUDED.vote,
          reason = EXCLUDED.reason,
          created_at = now()
      `;
    } catch (e: any) {
      return c.json({ error: "vote_failed", message: e.message }, 500);
    }

    // Update vote counts on the request
    const voteCounts = await sql<any[]>`
      SELECT
        COUNT(*) FILTER (WHERE vote = 'confirm') AS confirm_count,
        COUNT(*) FILTER (WHERE vote = 'reject') AS reject_count
      FROM news_request_votes
      WHERE request_id = ${id}
    `;

    const confirmCount = Number(voteCounts[0]?.confirm_count || 0);
    const rejectCount = Number(voteCounts[0]?.reject_count || 0);

    await sql`
      UPDATE news_re_evaluate_requests
      SET confirm_votes = ${confirmCount},
          reject_votes = ${rejectCount}
      WHERE id = ${id}
    `;

    // Auto-validate if enough confirm votes (3+)
    if (confirmCount >= 3 && confirmCount > rejectCount) {
      await sql`
        UPDATE news_re_evaluate_requests
        SET community_status = 'validated',
            community_validated_at = now()
        WHERE id = ${id} AND community_status = 'open'
      `;
    }

    // Auto-reject if enough reject votes (3+)
    if (rejectCount >= 3 && rejectCount > confirmCount) {
      await sql`
        UPDATE news_re_evaluate_requests
        SET community_status = 'rejected'
        WHERE id = ${id} AND community_status = 'open'
      `;
    }

    // Trigger AI validation for confirm votes with a reason on open tickets.
    // Runs asynchronously — doesn't block the vote response.
    //
    // Queue migration (Task 3.3): the inline
    // `python3 -m worker.ai_validate <id>` spawn is gone; the helper
    // now lives at `worker.ai_validate.validate_request` and runs
    // under the `community_triage` job kind. We enqueue with
    // `waitMs: 0` (fire-and-forget, matching the pre-migration
    // `detached: true, stdio: "ignore", child.unref()` semantic).
    // The route returns immediately with `kind: 'async'`; the worker
    // persists the AI validation to
    // `news_re_evaluate_requests.result->>'ai_validation'`.
    if (vote === 'confirm' && reqRows[0].community_status === 'open') {
      // First confirm: enqueue AI validation. Idempotent across multiple
      // confirm votes via the persisted-ai-validation check below.
      const hasAi = await sql<any[]>`
        SELECT 1 FROM news_re_evaluate_requests
        WHERE id = ${id} AND result->>'ai_validation' IS NOT NULL
        LIMIT 1
      `;
      if (hasAi.length === 0) {
        try {
          const result = await enqueueOrSpawn(
            "community_triage",
            { op: "ai_validate", request_id: id },
            { waitMs: 0, enqueuedBy: "api/community/vote/ai-validate" },
          );
          const requestId = result.kind === "async" ? result.requestId : "sync";
          console.log(
            `[vote] triggered AI validation for request ${id} (kind=${result.kind}, job=${requestId})`,
          );
        } catch (e: any) {
          // Best-effort — never let a background-validation failure
          // block the user from casting their vote (matches the
          // pre-migration site's lack of error handling on the
          // detached spawn).
          console.warn(
            "[vote] community_triage enqueue failed:",
            (e as Error).message,
          );
        }
      }
    }

    return c.json({
      success: true,
      vote,
      reason: reason || null,
      confirm_votes: confirmCount,
      reject_votes: rejectCount,
      community_status: confirmCount >= 3 && confirmCount > rejectCount
        ? "validated"
        : rejectCount >= 3 && rejectCount > confirmCount
          ? "rejected"
          : "open",
    });
  },
);

// ── GET /api/community/area-requests ──────────────────────────────────────
//
// List public coverage (area) requests — recommend-news only. Auto-discover
// rows are excluded via request_source='recommend-news'. Worker-status
// `dismissed`/`failed` are also excluded so users don't see dead rows.
//
// Mirrors the shape of /api/community/requests so the /help/ Coverage
// Requests UI can render with minimal changes.
communityRoute.get("/community/area-requests", async (c) => {
  const sql = getDb();
  const status = c.req.query("status") || "all";
  const limit = Math.min(Number(c.req.query("limit") || 50), 200);
  const offset = Number(c.req.query("offset") || 0);

  let whereClause = sql`r.public_visible = TRUE
    AND r.request_source = 'recommend-news'
    AND r.status NOT IN ('dismissed', 'failed')`;

  if (status === "open") {
    whereClause = sql`${whereClause} AND r.community_status = 'open'`;
  } else if (status === "validated") {
    whereClause = sql`${whereClause} AND r.community_status = 'validated'`;
  } else if (status === "rejected") {
    whereClause = sql`${whereClause} AND r.community_status = 'rejected'`;
  } else if (status === "applied") {
    whereClause = sql`${whereClause} AND r.applied_at IS NOT NULL`;
  }

  const rows = await sql<any[]>`
    SELECT
      r.id,
      r.bbox_min_lat, r.bbox_min_lng, r.bbox_max_lat, r.bbox_max_lng,
      r.center_lat, r.center_lng, r.map_zoom,
      r.session_id, r.message, r.status AS worker_status,
      r.request_source,
      r.community_status, r.confirm_votes, r.reject_votes,
      r.community_validated_at, r.applied_at, r.applied_job_id,
      r.requested_at
    FROM news_area_requests r
    WHERE ${whereClause}
    ORDER BY r.requested_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const countRow = await sql<any[]>`
    SELECT COUNT(*) as total
    FROM news_area_requests r
    WHERE ${whereClause}
  `;

  // Status counts for filter-button labels.
  const statusCounts = await sql<any[]>`
    SELECT community_status, COUNT(*)::int AS n
    FROM news_area_requests
    WHERE public_visible = TRUE
      AND request_source = 'recommend-news'
      AND status NOT IN ('dismissed', 'failed')
    GROUP BY 1
  `;
  const counts: Record<string, number> = { open: 0, validated: 0, rejected: 0, applied: 0 };
  for (const r of statusCounts) {
    counts[r.community_status] = Number(r.n);
  }
  const appliedCount = await sql<any[]>`
    SELECT COUNT(*)::int AS n
    FROM news_area_requests
    WHERE public_visible = TRUE
      AND request_source = 'recommend-news'
      AND status NOT IN ('dismissed', 'failed')
      AND applied_at IS NOT NULL
  `;
  counts.applied = Number(appliedCount[0]?.n || 0);

  return c.json({
    area_requests: rows.map((r) => ({
      id: Number(r.id),
      bbox: {
        min_lat: Number(r.bbox_min_lat),
        min_lng: Number(r.bbox_min_lng),
        max_lat: Number(r.bbox_max_lat),
        max_lng: Number(r.bbox_max_lng),
      },
      center: {
        lat: Number(r.center_lat),
        lng: Number(r.center_lng),
      },
      map_zoom: r.map_zoom,
      message: r.message ? String(r.message).slice(0, 500) : null,
      session_id: r.session_id,
      worker_status: r.worker_status,
      community_status: r.community_status,
      confirm_votes: Number(r.confirm_votes),
      reject_votes: Number(r.reject_votes),
      community_validated_at: r.community_validated_at,
      applied_at: r.applied_at,
      applied_job_id: r.applied_job_id,
      requested_at: r.requested_at,
    })),
    total: Number(countRow[0]?.total || 0),
    counts,
    limit,
    offset,
  });
});

// ── POST /api/community/area-requests/:id/vote ────────────────────────────
//
// Vote on a coverage (area) request. Same shape as
// /api/community/requests/:id/vote but on news_area_requests +
// news_area_request_votes. On reaching 3+ confirm votes, atomically
// claim the row (only one transaction wins) and enqueue an
// explore_region job for the bbox.
communityRoute.post(
  "/community/area-requests/:id/vote",
  zValidator("json", VoteSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = voteLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
    }

    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) return c.json({ error: "bad_id" }, 400);

    const { vote, reason } = c.req.valid("json");
    const sql = getDb();

    // Fetch + pre-flight checks.
    const reqRows = await sql<any[]>`
      SELECT id, community_status, request_source
      FROM news_area_requests
      WHERE id = ${id} AND public_visible = TRUE
      LIMIT 1
    `;
    if (reqRows.length === 0) return c.json({ error: "not_found" }, 404);
    if (reqRows[0].request_source !== "recommend-news") {
      return c.json(
        { error: "not_voteable", reason: "auto-discover rows are not voteable" },
        400,
      );
    }
    if (reqRows[0].community_status !== "open") {
      return c.json(
        { error: "voting_closed", status: reqRows[0].community_status },
        400,
      );
    }

    // Upsert vote (one vote per IP per request).
    const voterIp = ip !== 'unknown' ? ip : '0.0.0.0';
    try {
      await sql`
        INSERT INTO news_area_request_votes (request_id, voter_ip, vote, reason)
        VALUES (${id}, ${voterIp}::inet, ${vote}, ${reason || null})
        ON CONFLICT (request_id, voter_ip) DO UPDATE SET
          vote = EXCLUDED.vote,
          reason = EXCLUDED.reason,
          created_at = now()
      `;
    } catch (e: any) {
      return c.json({ error: "vote_failed", message: e.message }, 500);
    }

    // Recompute counts.
    const voteCounts = await sql<any[]>`
      SELECT
        COUNT(*) FILTER (WHERE vote = 'confirm') AS confirm_count,
        COUNT(*) FILTER (WHERE vote = 'reject') AS reject_count
      FROM news_area_request_votes
      WHERE request_id = ${id}
    `;

    const confirmCount = Number(voteCounts[0]?.confirm_count || 0);
    const rejectCount = Number(voteCounts[0]?.reject_count || 0);

    await sql`
      UPDATE news_area_requests
      SET confirm_votes = ${confirmCount},
          reject_votes = ${rejectCount}
      WHERE id = ${id}
    `;

    // Threshold transitions + idempotent enqueue.
    let appliedJobId: string | null = null;

    if (confirmCount >= 3 && confirmCount > rejectCount) {
      // Atomic claim: only one transaction wins. Concurrent votes that
      // both see confirmCount=3 race here — the loser finds
      // community_status='validated' (or applied_at IS NOT NULL) and
      // returns 0 rows. Guarantees a single explore_region enqueue per
      // request.
      const claimed = await sql<any[]>`
        UPDATE news_area_requests
        SET community_status = 'validated',
            community_validated_at = now(),
            applied_at = now(),
            applied_job_id = NULL
        WHERE id = ${id}
          AND community_status = 'open'
          AND applied_at IS NULL
        RETURNING bbox_min_lat, bbox_min_lng, bbox_max_lat, bbox_max_lng, map_zoom
      `;

      if (claimed.length > 0) {
        const r = claimed[0];
        // Payload shape mirrors /api/explore-region: bbox is
        // [min_lng, min_lat, max_lng, max_lat].
        const bbox = [
          Number(r.bbox_min_lng),
          Number(r.bbox_min_lat),
          Number(r.bbox_max_lng),
          Number(r.bbox_max_lat),
        ];
        const mapZoom = r.map_zoom ?? null;
        try {
          const result = await enqueueOrSpawn(
            "explore_region",
            { bbox, auto_add: false, category_hint: undefined },
            { waitMs: 0, enqueuedBy: "api/community/area-requests/vote" },
          );
          if (result.kind === "async") {
            appliedJobId = result.requestId;
            await sql`
              UPDATE news_area_requests
              SET applied_job_id = ${appliedJobId}::uuid
              WHERE id = ${id}
            `;
          }
          // legacy fallback path removed; result.kind is always 'async' for
          // the queue, and applied_job_id is the queue's UUID.
          console.log(
            `[area-requests/vote] id=${id} → validated, enqueued explore_region (${result.kind}${appliedJobId ? ", job=" + appliedJobId : ""})`,
          );
        } catch (e: any) {
          // Row is already validated+applied_at, but no job landed.
          // An admin can re-trigger via /api/explore-region with the
          // bbox. Don't fail the vote — the threshold was reached and
          // the user's vote was recorded.
          console.warn(
            `[area-requests/vote] id=${id} enqueue failed: ${(e as Error).message}`,
          );
        }
      }
    } else if (rejectCount >= 3 && rejectCount > confirmCount) {
      await sql`
        UPDATE news_area_requests
        SET community_status = 'rejected'
        WHERE id = ${id} AND community_status = 'open'
      `;
    }

    // First confirm: enqueue AI validation. Idempotent across multiple
    // confirm votes — only fires when no AI reply row exists yet.
    if (vote === 'confirm' && reqRows[0].community_status === 'open') {
      const hasAi = await sql<any[]>`
        SELECT 1 FROM news_area_request_replies
        WHERE request_id = ${id} AND reply_type = 'ai'
        LIMIT 1
      `;
      if (hasAi.length === 0) {
        try {
          const result = await enqueueOrSpawn(
            "community_triage",
            { op: "ai_validate_area", request_id: id },
            { waitMs: 0, enqueuedBy: "api/community/area-requests/vote/ai-validate" },
          );
          const requestId = result.kind === "async" ? result.requestId : "sync";
          console.log(
            `[area-requests/vote] triggered AI validation for request ${id} (kind=${result.kind}, job=${requestId})`,
          );
        } catch (e: any) {
          console.warn(
            "[area-requests/vote] community_triage enqueue failed:",
            (e as Error).message,
          );
        }
      }
    }

    return c.json({
      success: true,
      vote,
      reason: reason || null,
      confirm_votes: confirmCount,
      reject_votes: rejectCount,
      community_status: confirmCount >= 3 && confirmCount > rejectCount
        ? "validated"
        : rejectCount >= 3 && rejectCount > confirmCount
          ? "rejected"
          : "open",
      applied_job_id: appliedJobId,
    });
  },
);

// ── POST /api/community/requests/:id/ai-validate ─────────────────────
//
// Trigger an AI validation of a location correction request. The AI
// evaluates whether the user's suggested location is plausible given
// the article title/body and the current location. Writes the result
// back to the request's `result` JSONB column.
//
// Called automatically when a user casts a "confirm" vote with a
// reason on an open ticket. Also callable manually by admins.
//
// Queue migration: the inline `python3 -m worker.ai_validate <id>`
// spawn (and the prompt-building + JS heuristic fallback that
// surrounded it) is gone. We now call `enqueueOrSpawn` with
// `waitMs: 0` — the worker runs under the `community_triage` job
// kind and persists the validation result to
// `news_re_evaluate_requests.result->>'ai_validation'` itself.
//
// The route returns 202 with the queue's requestId and a `statusUrl`
// that points at `/api/discovery-status/<id>`. The admin UI / poll
// loop reads the completed `result` from that endpoint. The Python
// worker builds the prompt, calls the AI, and falls back to its own
// in-process `_heuristic_validate` when the breaker is open — no
// JS-side prompt/heuristic needed here.
communityRoute.post(
  "/community/requests/:id/ai-validate",
  async (c) => {
    const gate = await adminAuth(c, ["super", "editorial"]);
    if (!gate.ok) return gate.response;

    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) return c.json({ error: "bad_id" }, 400);

    const sql = getDb();

    // Fetch the request + article context for the AI worker (it pulls
    // the same fields itself when running normally).
    const rows = await sql<any[]>`
      SELECT r.id, r.pin_id, r.article_id, r.kind, r.user_place,
             r.community_status, r.result,
             a.title AS article_title, a.body AS article_body,
             a.location_text AS current_location,
             l.place_name AS current_place_name, l.country AS current_country,
             l.lat AS current_lat, l.lng AS current_lng
      FROM news_re_evaluate_requests r
      LEFT JOIN news_articles a ON a.id = r.article_id
      LEFT JOIN news_locations l ON l.id = a.location_id
      WHERE r.id = ${id}
      LIMIT 1
    `;
    if (rows.length === 0) return c.json({ error: "not_found" }, 404);
    const req = rows[0];

    try {
      const result = await enqueueOrSpawn<Record<string, unknown>>(
        "community_triage",
        { op: "ai_validate", request_id: id },
        { waitMs: 0, enqueuedBy: "api/community/ai-validate" },
      );

      if (result.kind === "async") {
        // Queue path. The worker persists to JSONB itself; the admin
        // polls /api/discovery-status/:id and reads `result` from
        // there once status === 'completed'.
        return c.json(
          {
            kind: "async",
            requestId: result.requestId,
            statusUrl: `/api/discovery-status/${result.requestId}`,
            ai_validation_pending: true,
          },
          202,
        );
      }

      // Legacy path: Python persisted to JSONB itself (via
      // _persist_result). We re-merge here to mirror the
      // pre-migration response shape (`{success, ai}`).
      const ai = (result.result || {}) as Record<string, unknown>;
      const merged = {
        ...(req.result || {}),
        ai_validation: {
          ...ai,
          method: (ai as any).method || "ai",
          validated_at:
            (ai as any).validated_at || new Date().toISOString(),
        },
      };
      await sql`
        UPDATE news_re_evaluate_requests
        SET result = ${JSON.stringify(merged)}::jsonb
        WHERE id = ${id}
      `;
      return c.json({ success: true, ai: merged.ai_validation });
    } catch (e: any) {
      // Legacy mode only — the queue path returns `{kind: 'async'}`
      // for `waitMs: 0` and never throws from the spawn. The Python
      // helper already falls back to its own heuristic when the AI
      // breaker is open, so reaching this catch means the worker
      // process crashed or couldn't be spawned at all. Run the JS
      // heuristic so the admin gets a usable result (matches
      // pre-migration `_spawn_failed` behavior).
      console.warn(
        "[ai-validate] community_triage spawn failed, using JS heuristic:",
        (e as Error).message,
      );
      const heuristic = await runHeuristicValidate(req);
      const merged = {
        ...(req.result || {}),
        ai_validation: {
          ...heuristic,
          validated_at: new Date().toISOString(),
          spawned_failure: (e as Error).message,
        },
      };
      await sql`
        UPDATE news_re_evaluate_requests
        SET result = ${JSON.stringify(merged)}::jsonb
        WHERE id = ${id}
      `;
      return c.json({ success: true, ai: merged.ai_validation, fell_back: true });
    }
  },
);

// ── In-process heuristic validator ────────────────────────────────────
//
// Mirror of worker.ai_validate._heuristic_validate. Used when the
// Python worker process fails to spawn so the HTTP caller still gets
// an answer. Marked method='heuristic' so the audit trail stays
// honest about who decided.
async function runHeuristicValidate(req: any) {
  const title = (req.article_title || "").toLowerCase();
  const body = ((req.article_body || "").slice(0, 500)).toLowerCase();
  const fullText = `${title} ${body}`;
  const userPlace = (req.user_place || "").trim();
  const current = (req.current_place_name || "").toLowerCase();

  if (!userPlace) {
    return {
      valid: false, confidence: 0.0,
      reasoning: "no user suggestion provided",
      suggested_place: null, method: "heuristic",
    };
  }

  const placeLower = userPlace.toLowerCase();
  const placeTokens = placeLower.split(/[\s,]+/).filter((t: string) => t.length >= 4);
  const hits = placeTokens.filter((t: string) => fullText.includes(t)).length;

  const reasons: string[] = [];
  let confidence = 0;
  if (hits > 0) {
    confidence += Math.min(hits * 0.15, 0.5);
    reasons.push(`${hits} significant token(s) from user_place appear in article`);
  }
  if (!reasons.length) reasons.push("no textual signal supports the user's suggestion");
  const valid = confidence >= 0.4;
  return {
    valid,
    confidence: Math.min(confidence, 0.85),
    reasoning: "Heuristic: " + reasons.join("; "),
    suggested_place: valid ? userPlace : null,
    method: "heuristic",
  };
}

// ── GET /api/community/stats ────────────────────────────────────────────
//
// Get community validation statistics.
communityRoute.get("/community/stats", async (c) => {
  const sql = getDb();

  const stats = await sql<any[]>`
    SELECT
      COUNT(*) FILTER (WHERE community_status = 'open') AS open_count,
      COUNT(*) FILTER (WHERE community_status = 'validated') AS validated_count,
      COUNT(*) FILTER (WHERE community_status = 'rejected') AS rejected_count,
      COUNT(*) FILTER (WHERE (result->>'applied')::boolean = TRUE) AS applied_count,
      COUNT(*) AS total_count
    FROM news_re_evaluate_requests
    WHERE kind = 'suggest_location' AND public_visible = TRUE
  `;

  const recentVotes = await sql<any[]>`
    SELECT COUNT(*) AS vote_count
    FROM news_request_votes
    WHERE created_at > now() - interval '24 hours'
  `;

  return c.json({
    requests: {
      open: Number(stats[0]?.open_count || 0),
      validated: Number(stats[0]?.validated_count || 0),
      rejected: Number(stats[0]?.rejected_count || 0),
      applied: Number(stats[0]?.applied_count || 0),
      total: Number(stats[0]?.total_count || 0),
    },
    votes_24h: Number(recentVotes[0]?.vote_count || 0),
  });
});

// ── GET /api/system/logs ────────────────────────────────────────────────
//
// Get system activity logs (recent requests, worker activity, etc.)
communityRoute.get("/system/logs", async (c) => {
  // Tier 1.6: gate — exposes request / vote / reply activity logs that
  // contain user_place + result blobs. Operator-only.
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;

  const sql = getDb();
  const limit = Math.min(Number(c.req.query("limit") || 100), 500);
  const type = c.req.query("type") || "all"; // all, requests, votes, replies

  let logs: any[] = [];

  if (type === "all" || type === "requests") {
    const requests = await sql<any[]>`
      SELECT
        'request' AS log_type,
        id,
        requested_at AS timestamp,
        status,
        kind,
        user_place,
        community_status,
        pin_id,
        article_id,
        result
      FROM news_re_evaluate_requests
      ORDER BY requested_at DESC
      LIMIT ${limit}
    `;
    logs.push(...requests);
  }

  if (type === "all" || type === "votes") {
    const votes = await sql<any[]>`
      SELECT
        'vote' AS log_type,
        v.id,
        v.created_at AS timestamp,
        v.vote AS status,
        v.reason,
        v.request_id,
        r.pin_id,
        r.user_place
      FROM news_request_votes v
      JOIN news_re_evaluate_requests r ON r.id = v.request_id
      ORDER BY v.created_at DESC
      LIMIT ${limit}
    `;
    logs.push(...votes);
  }

  if (type === "all" || type === "replies") {
    const replies = await sql<any[]>`
      SELECT
        'reply' AS log_type,
        rp.id,
        rp.created_at AS timestamp,
        rp.reply_type AS status,
        rp.reply_text AS reason,
        rp.request_id,
        r.pin_id,
        r.user_place
      FROM news_request_replies rp
      JOIN news_re_evaluate_requests r ON r.id = rp.request_id
      ORDER BY rp.created_at DESC
      LIMIT ${limit}
    `;
    logs.push(...replies);
  }

  // Sort by timestamp
  logs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  logs = logs.slice(0, limit);

  // postgres-js returns BIGINT id columns as BigInt by default, which
  // JSON.stringify can't serialize. Coerce every id-shaped field to
  // Number before the response goes out.
  for (const log of logs) {
    if (typeof log.id === "bigint") log.id = Number(log.id);
    if (typeof log.pin_id === "bigint") log.pin_id = Number(log.pin_id);
    if (typeof log.article_id === "bigint") log.article_id = Number(log.article_id);
    if (typeof log.request_id === "bigint") log.request_id = Number(log.request_id);
  }

  return c.json({
    logs,
    count: logs.length,
  });
});

// ── POST /api/system/reply ──────────────────────────────────────────────
//
// Add an admin/AI reply to a request.
const ReplySchema = z.object({
  reply_type: z.enum(["admin", "ai", "system"]),
  reply_text: z.string().min(1).max(2000),
  metadata: z.any().optional(),
});

communityRoute.post(
  "/system/reply",
  zValidator("json", ReplySchema),
  async (c) => {
    const gate = await adminAuth(c, ["super", "editorial"]);
    if (!gate.ok) return gate.response;

    const id = Number(c.req.query("request_id"));
    if (!Number.isInteger(id) || id < 1) return c.json({ error: "bad_request_id" }, 400);

    const { reply_type, reply_text, metadata } = c.req.valid("json");
    const sql = getDb();

    // Check request exists
    const reqRows = await sql<any[]>`
      SELECT id FROM news_re_evaluate_requests WHERE id = ${id} LIMIT 1
    `;
    if (reqRows.length === 0) return c.json({ error: "not_found" }, 404);

    await sql`
      INSERT INTO news_request_replies (request_id, reply_type, reply_text, metadata)
      VALUES (${id}, ${reply_type}, ${reply_text}, ${metadata ? JSON.stringify(metadata) : null}::jsonb)
    `;

    return c.json({ success: true });
  },
);
