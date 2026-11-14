import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { spawn } from "node:child_process";
import { getDb } from "../db";
import { SuggestLocationSchema, SuggestCoordsSchema, PinReportSchema } from "../validate";
import { RateLimiter, getClientIp } from "../ratelimit";
import { enqueueOrSpawn } from "../queue/enqueueOrSpawn";
import { adminAuth } from "../auth";

export const feedbackRoute = new Hono();

// 10 requests/hour/IP — lets users retry but stops abuse.
const reEvalLimiter = new RateLimiter({ max: 10, windowMs: 60 * 60 * 1000 });

// 30 requests/hour/IP for fast suggestions (more generous)
const fastSuggestLimiter = new RateLimiter({ max: 30, windowMs: 60 * 60 * 1000 });

// Worker lives at /var/www/vhosts/xyzo.org per the existing convention;
// we keep that path overridable for tests.
const WORKER_CWD = process.env.NEWSIUM_WORKER_CWD || "/var/www/vhosts/xyzo.org";

// ── Helpers ─────────────────────────────────────────────────────────

async function fetchArticleForPin(pinId: number) {
  // Resolve pin → article for RSS pins; editorial/community have no
  // news_articles row to re-extract from.
  //
  // NOTE: The /api/pins endpoint returns a UNION of pins and news_articles,
  // so the ID might be from either table. We check both.
  const sql = getDb();

  // First try: look in pins table (traditional path)
  const pinRows = await sql<any[]>`
    SELECT a.id AS article_id, a.title, a.body, a.location_text,
           a.event_type, a.location_id, l.lat, l.lng, l.place_name,
           p.source_type
    FROM pins p
    LEFT JOIN rss_details r ON r.pin_id = p.id
    LEFT JOIN news_articles a ON a.url = r.source_url
    LEFT JOIN news_locations l ON l.id = a.location_id
    WHERE p.id = ${pinId}
    LIMIT 1
  `;
  if (pinRows[0] && pinRows[0].article_id) return pinRows[0];

  // Second try: the ID might be a news_articles ID directly
  // (from the UNION ALL in /api/pins endpoint)
  const articleRows = await sql<any[]>`
    SELECT a.id AS article_id, a.title, a.body, a.location_text,
           a.event_type, a.location_id, l.lat, l.lng, l.place_name,
           'rss' AS source_type
    FROM news_articles a
    LEFT JOIN news_locations l ON l.id = a.location_id
    WHERE a.id = ${pinId}
    LIMIT 1
  `;
  return articleRows[0] || null;
}

async function enqueueRequest(opts: {
  pinId: number;
  articleId: number | null;
  kind: "re_evaluate" | "suggest_location";
  userPlace?: string | null;
  ip: string | null;
  mapCenterLat?: number | null;
  mapCenterLng?: number | null;
  mapZoom?: number | null;
}): Promise<{ id: number; deduped: boolean }> {
  const sql = getDb();
  // Sanitize IP - PostgreSQL INET type doesn't accept "unknown"
  const sanitizedIp = opts.ip && opts.ip !== "unknown" ? opts.ip : null;

  // Dedup via unique partial index: if a queued/running request already
  // exists for this (article_id, kind, user_place), return its id.
  const dedupRows = await sql<any[]>`
    SELECT id FROM news_re_evaluate_requests
    WHERE pin_id = ${opts.pinId}
      AND kind = ${opts.kind}
      AND ${opts.userPlace ?? null} IS NOT DISTINCT FROM ${opts.userPlace ?? null}
      AND status IN ('queued', 'running')
    LIMIT 1
  `;
  if (dedupRows.length > 0) {
    return { id: Number(dedupRows[0].id), deduped: true };
  }
  const rows = await sql<{ id: number | bigint }[]>`
    INSERT INTO news_re_evaluate_requests
      (pin_id, article_id, kind, user_place, requester_ip,
       map_center_lat, map_center_lng, map_zoom)
    VALUES
      (${opts.pinId}, ${opts.articleId}, ${opts.kind}, ${opts.userPlace ?? null}, ${sanitizedIp},
       ${opts.mapCenterLat ?? null}, ${opts.mapCenterLng ?? null}, ${opts.mapZoom ?? null})
    ON CONFLICT (dedup_key) WHERE status IN ('queued','running')
      DO NOTHING
    RETURNING id
  `;
  if (rows.length === 0) {
    // Race: someone else inserted at the same instant. Fetch and return theirs.
    const fb = await sql<any[]>`
      SELECT id FROM news_re_evaluate_requests
      WHERE pin_id = ${opts.pinId}
        AND kind = ${opts.kind}
        AND ${opts.userPlace ?? null} IS NOT DISTINCT FROM ${opts.userPlace ?? null}
        AND status IN ('queued', 'running')
      LIMIT 1
    `;
    return { id: Number(fb[0].id), deduped: true };
  }
  return { id: Number(rows[0].id), deduped: false };
}

function fireWorker(requestId: number): void {
  // Spawn detached. Worker writes status + result to the row by id.
  const child = spawn(
    "/usr/bin/python3.11",
    ["-m", "worker.run", "--re-evaluate-request", String(requestId), "--quiet"],
    {
      cwd: WORKER_CWD,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
      },
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
}

// ── POST /api/pins/:id/re-evaluate ───────────────────────────────────

feedbackRoute.post("/pins/:id/re-evaluate", async (c) => {
  const ip = getClientIp(c.req.raw);
  const limit = reEvalLimiter.check(ip);
  if (!limit.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: limit.retryAfterMs }, 429);
  }
  const pinId = Number(c.req.param("id"));
  if (!Number.isInteger(pinId) || pinId < 1) {
    return c.json({ error: "bad_id" }, 400);
  }
  const article = await fetchArticleForPin(pinId);
  if (!article || !article.article_id) {
    return c.json({
      error: "no_article",
      message: "Pin has no underlying article to re-evaluate (editorial/community pins cannot be re-extracted).",
    }, 422);
  }

  // NEW: read optional map view from body
  let mapCenterLat: number | null = null;
  let mapCenterLng: number | null = null;
  let mapZoom: number | null = null;
  try {
    const body = await c.req.json().catch(() => ({} as any));
    if (Number.isFinite(body?.map_center_lat)) mapCenterLat = Number(body.map_center_lat);
    if (Number.isFinite(body?.map_center_lng)) mapCenterLng = Number(body.map_center_lng);
    if (Number.isFinite(body?.map_zoom)) mapZoom = Math.round(Number(body.map_zoom));
  } catch (_) { /* body is optional */ }

  const { id, deduped } = await enqueueRequest({
    pinId,
    articleId: Number(article.article_id),
    kind: "re_evaluate",
    userPlace: null,
    ip,
    mapCenterLat, mapCenterLng, mapZoom,
  });
  if (!deduped) fireWorker(id);
  return c.json({
    request_id: id,
    status: deduped ? "already_queued" : "queued",
    pin_id: pinId,
    article_id: Number(article.article_id),
  }, 202);
});

// ── POST /api/pins/:id/suggest-location ──────────────────────────────
//
// User-driven prose correction: they type "Beirut, Lebanon" or "this is
// about Tokyo, not Seoul" and the worker reverse-resolves it against the
// article body. The optional lat/lng/radius_km lets the same endpoint
// handle map clicks ("drop a pin at 33.89, 35.50 for this story") so the
// frontend can call one endpoint whether the user typed a description,
// clicked the map, or did both.
feedbackRoute.post("/pins/:id/suggest-location", zValidator("json", SuggestLocationSchema), async (c) => {
  const ip = getClientIp(c.req.raw);
  const limit = reEvalLimiter.check(ip);
  if (!limit.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: limit.retryAfterMs }, 429);
  }
  const pinId = Number(c.req.param("id"));
  if (!Number.isInteger(pinId) || pinId < 1) {
    return c.json({ error: "bad_id" }, 400);
  }
  const { place_text, lat, lng, radius_km, map_center_lat, map_center_lng, map_zoom } = c.req.valid("json");
  const article = await fetchArticleForPin(pinId);
  if (!article || !article.article_id) {
    return c.json({
      error: "no_article",
      message: "Pin has no underlying article to evaluate the suggestion against (only RSS-sourced pins can be relocated through this endpoint).",
    }, 422);
  }
  // Pack the suggestion into user_place. Worker recognises three prefixes:
  //   "text:…"                       → reverse-geocode free-form text (Nominatim)
  //   "coords:lat,lng,radius_km,confidence[,url-encoded note]"
  //                                   → apply as a confirmed user map click
  //   "text+coords:lat,lng,radius_km,confidence,url-encoded note"
  //                                   → click + free-form note together
  // We pick `confidence` from radius_km: small radius = high confidence.
  let userPlace: string;
  let confidence: number | null = null;
  const hasText = !!place_text;
  const hasCoords = lat != null && lng != null;
  if (hasCoords) {
    const rkm = radius_km ?? 25;
    confidence = rkm <= 5 ? 0.9 : rkm <= 25 ? 0.85 : rkm <= 100 ? 0.7 : 0.55;
    const textPart = hasText ? `,${encodeURIComponent(place_text)}` : "";
    // Use the combined prefix when both signals are present.
    const prefix = hasText ? "text+coords:" : "coords:";
    userPlace = `${prefix}${lat.toFixed(4)},${lng.toFixed(4)},${rkm},${confidence}${textPart}`;
  } else {
    userPlace = `text:${place_text}`;
  }

  const { id, deduped } = await enqueueRequest({
    pinId,
    articleId: Number(article.article_id),
    kind: "suggest_location",
    userPlace,
    ip,
    mapCenterLat: map_center_lat ?? null,
    mapCenterLng: map_center_lng ?? null,
    mapZoom: map_zoom != null ? Math.round(map_zoom) : null,
  });
  if (!deduped) fireWorker(id);
  return c.json({
    request_id: id,
    status: deduped ? "already_queued" : "queued",
    pin_id: pinId,
    article_id: Number(article.article_id),
    user_place: place_text ?? null,
    coords: lat != null && lng != null ? { lat, lng, radius_km: radius_km ?? 25 } : null,
    confidence,
  }, 202);
});

// ── POST /api/pins/:id/fast-suggest ────────────────────────────────────
//
// Fast, synchronous location suggestion. Processes immediately and returns
// detailed results including step-by-step status. No worker spawning.
feedbackRoute.post("/pins/:id/fast-suggest", zValidator("json", SuggestLocationSchema), async (c) => {
  const ip = getClientIp(c.req.raw);
  const limit = fastSuggestLimiter.check(ip);
  if (!limit.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: limit.retryAfterMs }, 429);
  }

  const pinId = Number(c.req.param("id"));
  if (!Number.isInteger(pinId) || pinId < 1) {
    return c.json({ error: "bad_id" }, 400);
  }

  const { place_text, lat, lng, radius_km, map_center_lat, map_center_lng, map_zoom } = c.req.valid("json");
  const article = await fetchArticleForPin(pinId);
  if (!article || !article.article_id) {
    return c.json({
      error: "no_article",
      message: "Pin has no underlying article.",
    }, 422);
  }

  // Fire through the unified queue entry point. In queue mode this
  // waits up to 5s for the worker to finish (sync-wait, so the frontend
  // keeps seeing the existing step-by-step `applied/steps/result`
  // response shape). If the worker takes longer, the route surfaces a
  // 202 with the requestId + statusUrl so the frontend can poll
  // /api/discovery-status/:id — same envelope as the explore-region
  // cutover.
  const payload = {
    pin_id: pinId,
    article_id: Number(article.article_id),
    user_place: place_text || null,
    lat: lat ?? null,
    lng: lng ?? null,
    radius_km: radius_km ?? 25,
    map_center_lat: map_center_lat ?? null,
    map_center_lng: map_center_lng ?? null,
    map_zoom: map_zoom != null ? Math.round(map_zoom) : null,
  };
  try {
    const result = await enqueueOrSpawn<unknown>(
      "feedback_suggest",
      payload,
      { waitMs: 5000, enqueuedBy: "api/feedback/fast-suggest" },
    );
    if (result.kind === "async") {
      // Worker didn't finish within the 5s budget. Hand the requestId
      // back to the frontend so it can poll /api/discovery-status/:id.
      return c.json(result, 202);
    }
    return c.json(result.result);
  } catch (e: any) {
    // Legacy spawn errored (non-zero exit, parse failure) OR the queue
    // job failed / timed out. Surface a 500 with a short message so the
    // frontend dialog can render an error toast without crashing the
    // session.
    console.error("[fast-suggest] worker failed:", e?.message ?? e);
    return c.json({
      error: "worker_failed",
      message: typeof e?.message === "string" ? e.message.slice(-200) : "unknown",
    }, 500);
  }
});

// ── GET /api/pins/:id/suggestions ──────────────────────────────────────
//
// Get all previous suggestions and reports for a pin.
feedbackRoute.get("/pins/:id/suggestions", async (c) => {
  const pinId = Number(c.req.param("id"));
  if (!Number.isInteger(pinId) || pinId < 1) {
    return c.json({ error: "bad_id" }, 400);
  }

  const sql = getDb();

  // Get location suggestions
  const suggestions = await sql<any[]>`
    SELECT
      r.id,
      r.user_place,
      r.status,
      r.result,
      r.requested_at,
      r.completed_at,
      r.community_status,
      r.confirm_votes,
      r.reject_votes
    FROM news_re_evaluate_requests r
    WHERE r.pin_id = ${pinId} AND r.kind = 'suggest_location'
    ORDER BY r.requested_at DESC
    LIMIT 20
  `;

  // Get quality reports
  const reports = await sql<any[]>`
    SELECT
      report_type,
      reason,
      created_at
    FROM news_quality_reports
    WHERE article_id = ${pinId}
    ORDER BY created_at DESC
    LIMIT 10
  `;

  // Get article info
  const article = await sql<any[]>`
    SELECT
      a.id,
      a.title,
      a.location_text,
      l.place_name,
      l.country,
      l.lat,
      l.lng
    FROM news_articles a
    LEFT JOIN news_locations l ON l.id = a.location_id
    WHERE a.id = ${pinId}
    LIMIT 1
  `;

  return c.json({
    pin_id: pinId,
    article: article[0] || null,
    suggestions: suggestions.map(s => {
      const result = s.result || {};
      return {
        id: Number(s.id),
        user_place: s.user_place,
        status: s.status,
        community_status: s.community_status,
        confirm_votes: Number(s.confirm_votes || 0),
        reject_votes: Number(s.reject_votes || 0),
        applied: result.applied || false,
        result_lat: result.lat || null,
        result_lng: result.lng || null,
        result_place: result.place_name || null,
        requested_at: s.requested_at,
        completed_at: s.completed_at,
      };
    }),
    reports: reports.map(r => ({
      type: r.report_type,
      reason: r.reason,
      created_at: r.created_at,
    })),
  });
});

// ── POST /api/pins/:id/suggest-coords ────────────────────────────────
//
// User-driven correction: they click the map to indicate where the pin
// should be. Unlike /suggest-location (which queues a worker to AI-reverse-
// geocode a free-text place name), this endpoint takes raw {lat, lng}
// from the click — the user has already done the work, so the worker
// can apply the move with high confidence. The optional radius_km lets
// the user assert an area (e.g. "around Beirut") instead of a single
// point; the worker uses that to set suggested_precision (smaller
// radius → 'exact', larger → 'city').
//
// Flow:
//   1. Write the suggestion straight into news_articles.suggested_* so
//      it's visible to /api/pins immediately.
//   2. Enqueue a re-evaluate request and fire the worker (async). The
//      worker decides whether to apply the move to pins.location.
//   3. Return request_id so the frontend can poll /api/re-evaluate/:id
//      for completion.
feedbackRoute.post("/pins/:id/suggest-coords", zValidator("json", SuggestCoordsSchema), async (c) => {
  const ip = getClientIp(c.req.raw);
  const limit = reEvalLimiter.check(ip);
  if (!limit.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: limit.retryAfterMs }, 429);
  }
  const pinId = Number(c.req.param("id"));
  if (!Number.isInteger(pinId) || pinId < 1) {
    return c.json({ error: "bad_id" }, 400);
  }
  const { lat, lng, radius_km, place_text, map_center_lat, map_center_lng, map_zoom } = c.req.valid("json");
  const sql = getDb();

  // Only RSS pins have a news_articles row we can re-evaluate. Editorial
  // and community pins are user-curated — refuse explicitly so the
  // frontend can hide the button for those source_types.
  //
  // NOTE: The /api/pins endpoint returns a UNION of pins and news_articles,
  // so the ID might be from either table. We check both.
  let articleId: number | null = null;

  // First try: look in pins table (traditional path)
  const pinRows = await sql<any[]>`
    SELECT a.id AS article_id, a.title
    FROM pins p
    LEFT JOIN rss_details r ON r.pin_id = p.id
    LEFT JOIN news_articles a ON a.url = r.source_url
    WHERE p.id = ${pinId}
    LIMIT 1
  `;
  if (pinRows[0] && pinRows[0].article_id) {
    articleId = Number(pinRows[0].article_id);
  } else {
    // Second try: the ID might be a news_articles ID directly
    const articleRows = await sql<any[]>`
      SELECT id AS article_id, title
      FROM news_articles
      WHERE id = ${pinId}
      LIMIT 1
    `;
    if (articleRows[0]) {
      articleId = Number(articleRows[0].article_id);
    }
  }

  if (!articleId) {
    return c.json({
      error: "no_article",
      message: "Pin has no underlying article (only RSS-sourced pins can be relocated this way).",
    }, 422);
  }

  // Translate radius to a precision bucket: small radius = exact, medium =
  // city, large = region. The worker uses this when applying the move.
  //   <= 5 km  → "exact"
  //   <= 25 km → "city"
  //   ≤ 100 km → "region"
  //   else     → "country"
  let precision: "exact" | "city" | "region" | "country" = "exact";
  if (radius_km > 5)  precision = "city";
  if (radius_km > 25) precision = "region";
  if (radius_km > 100) precision = "country";
  const confidence = precision === "exact" ? 0.9
                   : precision === "city"   ? 0.85
                   : precision === "region" ? 0.7
                   : 0.55;
  // Encode the suggestion into user_place so the worker can decode
  // "coords:lat,lng,radius_km,confidence[,url-encoded text]" without
  // needing a new schema column. The optional text gives the AI a hint
  // about WHY the pin is wrong — useful when the click is approximate.
  const textPart = place_text ? `,${encodeURIComponent(place_text)}` : "";
  const userPlace = `coords:${lat.toFixed(4)},${lng.toFixed(4)},${radius_km},${confidence}${textPart}`;

  // Write the suggestion immediately. The worker will overwrite any of
  // these fields it disagrees with (e.g. if its AI reverse-geocodes the
  // article body and finds a more specific place), but the user's click
  // is the prior.
  const reasoningText = place_text
    ? `user click on map + note: ${place_text}`
    : "user click on map (suggest-coords endpoint)";
  await sql`
    UPDATE news_articles SET
      suggested_lat         = ${lat},
      suggested_lng         = ${lng},
      suggested_precision   = ${precision},
      suggested_confidence  = ${confidence},
      suggested_reasoning   = ${reasoningText},
      re_evaluated_at       = now()
    WHERE id = ${articleId}
  `;

  // Enqueue a re-evaluate request and fire the worker. The worker reads
  // the `coords:lat,lng,radius_km,confidence[,text]` user_place and applies
  // the move directly to pins.location. The frontend polls
  // /api/re-evaluate/:id to know when the pin actually moved.
  const { id, deduped } = await enqueueRequest({
    pinId,
    articleId,
    kind: "suggest_location",
    userPlace,
    ip,
    mapCenterLat: map_center_lat ?? null,
    mapCenterLng: map_center_lng ?? null,
    mapZoom: map_zoom != null ? Math.round(map_zoom) : null,
  });
  if (!deduped) fireWorker(id);

  return c.json({
    request_id: id,
    status: deduped ? "already_queued" : "queued",
    pin_id: pinId,
    article_id: articleId,
    suggested: {
      lat,
      lng,
      radius_km,
      precision,
      confidence,
      applied: false,
      text: place_text ?? null,
    },
  }, 202);
});

// ── POST /api/pins/:id/report ─────────────────────────────────────────
//
// The "Report Issue" tab of the combined feedback dialog
// (public_html/feedback-dialog.js). This endpoint did NOT exist when the
// dialog was written: it POSTed here and got a 404, which is why the
// dialog was never wired into the popup and ended up in a stash. Adding
// it is what makes the dialog loadable at all.
//
// A report is a moderation SIGNAL, never a verdict — nothing on this
// path edits or hides a pin. Rows land in news_quality_reports, the
// table created by migration 2026-09-05-missing-tables-and-indexes.sql
// for exactly this shape.
const reportLimiter = new RateLimiter({ max: 30, windowMs: 60 * 60 * 1000 });

feedbackRoute.post("/pins/:id/report", zValidator("json", PinReportSchema), async (c) => {
  const ip = getClientIp(c.req.raw);
  const limit = reportLimiter.check(ip);
  if (!limit.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: limit.retryAfterMs }, 429);
  }
  const pinId = Number(c.req.param("id"));
  if (!Number.isInteger(pinId) || pinId < 1) return c.json({ error: "bad_id" }, 400);

  const { report_type, reason, session_id } = c.req.valid("json");
  const sql = getDb();

  // Resolve the pin to its article. /api/pins returns a UNION of the
  // pins table and news_articles, so the id may belong to either.
  //
  // The direct news_articles match is only tried when the id is NOT a
  // pins row — falling through unconditionally would attach a report
  // about a community pin to whichever unrelated article happened to
  // share its integer id.
  let articleId: number | null = null;
  const pinRows = await sql<any[]>`
    SELECT a.id AS article_id
    FROM pins p
    LEFT JOIN rss_details r ON r.pin_id = p.id
    LEFT JOIN news_articles a ON a.url = r.source_url
    WHERE p.id = ${pinId}
    LIMIT 1`;
  if (pinRows[0]?.article_id) {
    articleId = Number(pinRows[0].article_id);
  } else {
    const notPins = await sql<any[]>`SELECT 1 FROM pins WHERE id = ${pinId} LIMIT 1`;
    if (!notPins[0]) {
      const rows = await sql<any[]>`
        SELECT id AS article_id FROM news_articles WHERE id = ${pinId} LIMIT 1`;
      if (rows[0]) articleId = Number(rows[0].article_id);
    }
  }

  // A community pin has no news_articles row; the report is still worth
  // recording, so article_id stays NULL (the column is nullable and the
  // FK is ON DELETE SET NULL). The pin id always goes into metadata.
  const ipAddr = ip && ip !== "unknown" ? ip : null;
  const ua = c.req.raw.headers.get("user-agent")?.slice(0, 400) ?? null;
  // sql.json(), the same convention jobQueue.ts:111 and statusWriter.ts
  // already use. A bare `${JSON.stringify(x)}::jsonb` stores the JSON as
  // a jsonb STRING (postgres.js parameterises the string, and casting a
  // parameterised string straight to jsonb does not parse it), so
  // `metadata->>'pin_id'` comes back NULL and nothing can find these
  // rows again. Probed:
  //   '${payload}'::jsonb          -> jsonb_typeof 'string'
  //   sql.json(payload) / ::text::jsonb -> jsonb_typeof 'object'
  await sql`
    INSERT INTO news_quality_reports
      (article_id, session_id, report_type, reason, ip_address, user_agent, metadata)
    VALUES
      (${articleId}, ${session_id ?? null}, ${report_type}, ${reason ?? null},
       ${ipAddr}::inet, ${ua}, ${sql.json({ pin_id: pinId })})`;

  return c.json({ ok: true, article_id: articleId }, 201);
});

// ── GET /api/re-evaluate/:id — poll for completion ───────────────────

feedbackRoute.get("/re-evaluate/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "bad_id" }, 400);
  const sql = getDb();
  const rows = await sql<any[]>`
    SELECT r.id, r.pin_id, r.kind, r.user_place, r.status,
           r.requested_at, r.started_at, r.completed_at,
           r.result, r.error_message,
           a.suggested_lat, a.suggested_lng, a.suggested_place_name,
           a.suggested_country, a.suggested_precision, a.suggested_confidence,
           a.suggested_reasoning, a.re_evaluated_at,
           a.location_id AS current_location_id
    FROM news_re_evaluate_requests r
    LEFT JOIN pins p ON p.id = r.pin_id
    LEFT JOIN rss_details rd ON rd.pin_id = p.id
    LEFT JOIN news_articles a ON a.url = rd.source_url
    WHERE r.id = ${id}
    LIMIT 1
  `;
  if (rows.length === 0) return c.json({ error: "not_found" }, 404);
  const r = rows[0];
  // The worker writes its decision into r.result as JSON: {"applied": bool,
  // "lat":..., "lng":..., "precision":..., "location_id":...}. Use that
  // as the source of truth for whether the pin actually moved; fall back
  // to the article's suggested_* fields if the worker hasn't recorded yet.
  const workerResult = (typeof r.result === "string" && r.result)
    ? safeJsonParse(r.result) : (r.result || {});
  const applied = typeof workerResult?.applied === "boolean"
    ? workerResult.applied
    : (r.status === "completed");  // legacy fallback
  const finalLat = workerResult?.lat ?? (r.suggested_lat != null ? Number(r.suggested_lat) : null);
  const finalLng = workerResult?.lng ?? (r.suggested_lng != null ? Number(r.suggested_lng) : null);
  const finalPrecision = workerResult?.precision ?? r.suggested_precision ?? null;
  const finalConfidence = workerResult?.confidence ?? (r.suggested_confidence != null ? Number(r.suggested_confidence) : null);

  return c.json({
    id: Number(r.id),
    pin_id: Number(r.pin_id),
    kind: r.kind,
    user_place: r.user_place,
    status: r.status,
    requested_at: r.requested_at,
    started_at: r.started_at,
    completed_at: r.completed_at,
    error_message: r.error_message,
    suggestion: finalLat != null && finalLng != null ? {
      lat: finalLat,
      lng: finalLng,
      place_name: r.suggested_place_name,
      country: r.suggested_country,
      precision: finalPrecision,
      confidence: finalConfidence,
      reasoning: r.suggested_reasoning,
      // Whether the worker actually moved the pin (vs just recorded the
      // suggestion). Drives the "Pin moved to the suggested area" copy
      // in the frontend.
      applied,
    } : null,
  });
});

function safeJsonParse(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}

// ── POST /api/feedback/bug-report ───────────────────────────────────
// User-submitted bug report with optional diagnostics blob. Backed by the
// feedback_bug_reports table (added in 2026-09-06-feedback-bug-reports.sql).
// Callers:
//   app.js:12087            (main UI bug-report dialog)
//   public_html/help/index.html:1547 (help-page bug-report form)
//
// T-13 closes the silent 404 that previously left users staring at
// "Submission error: HTTP 404" with no idea why their bug report vanished.

const bugReportLimiter = new RateLimiter({ max: 20, windowMs: 60 * 60 * 1000 });

import { z } from "zod";

const BugReportSchema = z.object({
  bug_type: z.string().min(1).max(80),
  description: z.string().min(1).max(8000),
  map_context: z.record(z.unknown()).optional(),
  session_id: z.string().max(200).optional(),
});

feedbackRoute.post(
  "/feedback/bug-report",
  zValidator("json", BugReportSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = bugReportLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
    }
    const { bug_type, description, map_context, session_id } = c.req.valid("json");
    const user_agent = c.req.header("user-agent") ?? null;
    // getClientIp returns the literal "unknown" when no proxy headers are
    // set; bind NULL so the inet cast doesn't reject the literal string.
    const ipOrNull = ip === "unknown" ? null : ip;

    const sql = getDb();
    const rows = await sql<{ id: string }[]>`
      INSERT INTO feedback_bug_reports
        (bug_type, description, map_context, session_id, requester_ip, user_agent)
      VALUES
        (${bug_type}, ${description}, ${sql.json(map_context ?? null)},
         ${session_id ?? null}, (${ipOrNull})::inet, ${user_agent})
      RETURNING id
    `;
    return c.json({ ok: true, id: Number(rows[0].id) });
  },
);

// ── POST /api/feedback/source-suggestion ───────────────────────────
// User-submitted news source suggestion. Backed by feedback_source_suggestions table.
const sourceSuggestLimiter = new RateLimiter({ max: 10, windowMs: 60 * 60 * 1000 });

const SourceSuggestionSchema = z.object({
  source_url: z.string().url().min(1).max(2000),
  source_name: z.string().max(200).optional(),
  country_code: z.string().length(2).optional(),
  description: z.string().max(1000).optional(),
  session_id: z.string().max(200).optional(),
});

feedbackRoute.post(
  "/feedback/source-suggestion",
  zValidator("json", SourceSuggestionSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = sourceSuggestLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
    }
    const { source_url, source_name, country_code, description, session_id } = c.req.valid("json");
    const user_agent = c.req.header("user-agent") ?? null;
    const ipOrNull = ip === "unknown" ? null : ip;

    const sql = getDb();
    const rows = await sql<{ id: string }[]>`
      INSERT INTO feedback_source_suggestions
        (source_url, source_name, country_code, description, session_id, requester_ip, user_agent)
      VALUES
        (${source_url}, ${source_name ?? null}, ${country_code ?? null}, ${description ?? null},
         ${session_id ?? null}, ${ipOrNull}::inet, ${user_agent})
      RETURNING id
    `;
    return c.json({ ok: true, id: Number(rows[0].id) });
  },
);

// ── GET /api/feedback/source-suggestions ───────────────────────
// Fetch user-submitted source suggestions (public).
feedbackRoute.get("/feedback/source-suggestions", async (c) => {
  const sql = getDb();
  const limit = Math.min(Number(c.req.query("limit") || 100), 500);
  const status = c.req.query("status") || "";

  let query = sql`
    SELECT id, source_url, source_name, country_code, description,
           session_id, status, created_at
    FROM feedback_source_suggestions
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  // If filtering by status, add WHERE clause
  if (status && ["pending", "reviewed", "approved", "rejected"].includes(status)) {
    query = sql`
      SELECT id, source_url, source_name, country_code, description,
             session_id, status, created_at
      FROM feedback_source_suggestions
      WHERE status = ${status}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  }

  const rows = await query;
  const total = await sql`SELECT COUNT(*) as count FROM feedback_source_suggestions`;
  const byStatus = await sql`
    SELECT status, COUNT(*) as count
    FROM feedback_source_suggestions
    GROUP BY status
  `;

  const statusCounts = {};
  for (const row of byStatus) {
    statusCounts[row.status] = Number(row.count);
  }

  // Convert BigInt id to Number for JSON serialization
  const items = rows.map(row => ({
    id: Number(row.id),
    source_url: row.source_url,
    source_name: row.source_name,
    country_code: row.country_code,
    description: row.description,
    session_id: row.session_id,
    status: row.status,
    created_at: row.created_at,
  }));

  return c.json({
    items,
    count: Number(total[0].count),
    status_counts: statusCounts,
  });
});

// ── POST /api/feedback/general-feedback ──────────────────────────
// User-submitted general feedback/comments. Uses existing help_suggestions table
// with a 'general_feedback' type marker in the context.
feedbackRoute.post(
  "/feedback/general-feedback",
  zValidator(
    "json",
    z.object({
      feedback: z.string().min(1).max(2000),
      session_id: z.string().max(200).optional(),
    }),
  ),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = reEvalLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_s: Math.ceil(rl.retryAfterMs / 1000) }, 429);
    }
    const { feedback, session_id } = c.req.valid("json");
    const user_agent = c.req.header("user-agent") || null;
    const sql = getDb();

    const rows = await sql<{ id: string }[]>`
      INSERT INTO help_suggestions
        (suggestion, context, user_ip, user_agent)
      VALUES
        (${feedback}, ${sql.json({ type: "general_feedback", session_id })}, ${ip}, ${user_agent})
      RETURNING id
    `;
    return c.json({ ok: true, id: Number(rows[0].id) });
  },
);

// ── POST /api/feedback/help-suggestion ─────────────────────────────
// Quick suggestion from help panel — saved for review by humans and AI.
feedbackRoute.post(
  "/feedback/help-suggestion",
  zValidator(
    "json",
    z.object({
      suggestion: z.string().min(1).max(500),
      context: z.object({
        viewport: z.string().optional(),
        zoom: z.number().optional(),
        url: z.string().optional(),
      }).optional(),
    }),
  ),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = reEvalLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_s: Math.ceil(rl.retryAfterMs / 1000) }, 429);
    }

    const { suggestion, context } = c.req.valid("json");
    const user_agent = c.req.header("user-agent") || null;
    const sql = getDb();

    const rows = await sql<{ id: string }[]>`
      INSERT INTO help_suggestions
        (suggestion, context, user_ip, user_agent)
      VALUES
        (${suggestion}, ${sql.json(context ?? null)}, (${ip})::inet, ${user_agent})
      RETURNING id
    `;
    return c.json({ ok: true, id: Number(rows[0].id) });
  },
);

// ── GET /api/feedback/help-suggestions ─────────────────────────────
// List suggestions for review (admin-only in production, but open for now).
feedbackRoute.get("/feedback/help-suggestions", async (c) => {
  const sql = getDb();
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const status = c.req.query("status") ?? "pending";

  const rows = await sql<any[]>`
    SELECT id, suggestion, context, status, ai_analysis, created_at, reviewed_at
    FROM help_suggestions
    WHERE status = ${status}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  return c.json({
    suggestions: rows.map(r => ({
      id: Number(r.id),
      suggestion: r.suggestion,
      context: r.context,
      status: r.status,
      ai_analysis: r.ai_analysis,
      created_at: new Date(r.created_at).toISOString(),
      reviewed_at: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
    })),
  });
});
