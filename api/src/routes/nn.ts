import { Hono } from "hono";
import { getDb } from "../db";
import { spawn } from "node:child_process";
import { adminAuth } from "../auth";

const WORKER_CWD = process.env.XYZO_WORKER_CWD || "/var/www/vhosts/xyzo.org";

export const nnRoute = new Hono();

// ── GET /api/nn/status ─────────────────────────────────────────────
// Neural system health dashboard. Returns per-model lifecycle state,
// training run history, prediction cache freshness, and feedback volume.
nnRoute.get("status", async (c) => {
  const db = getDb();

  const [systemStatus, trainingRuns, recentFeedback, cacheStats] = await Promise.all([
    db.unsafe(`
      SELECT
        m.model_name,
        m2.version,
        m2.trained_at,
        m2.metrics,
        COALESCE(ts.labeled_rows, 0) AS labeled_rows,
        COALESCE(ts.total_rows, 0)    AS total_rows,
        COALESCE(emb.embedding_count, 0) AS cached_embeddings,
        CASE
          WHEN m2.model_name IS NULL                       THEN 'not_trained'
          WHEN COALESCE(ts.labeled_rows, 0) < 100         THEN 'cold_start'
          WHEN m2.trained_at IS NOT NULL                   THEN 'trained_no_inference'
          ELSE 'not_trained'
        END AS lifecycle
      FROM (VALUES
        ('article_understanding'),('entity_extraction'),
        ('event_matching'),('relationship'),('ranking'),('coverage')
      ) AS m(model_name)
      LEFT JOIN nn_model_registry m2 ON m2.model_name = m.model_name AND m2.is_active = TRUE
      LEFT JOIN nn_v_training_summary ts ON ts.model_name = m.model_name
      LEFT JOIN (
        SELECT 'article_understanding' AS model_name, COUNT(*) AS embedding_count
        FROM nn_article_embeddings
      ) emb ON emb.model_name = m.model_name
    `),

    db.unsafe(`
      SELECT
        model_name, model_version, status,
        started_at, finished_at,
        rows_total, rows_train, rows_val,
        epochs_run, final_loss, final_metrics,
        error_message
      FROM nn_training_runs
      ORDER BY started_at DESC
      LIMIT 20
    `),

    db.unsafe(`
      SELECT
        model_name,
        COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') AS corrections_24h,
        COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')  AS corrections_7d,
        COUNT(*) FILTER (WHERE created_at > now() - interval '30 days') AS corrections_30d,
        COUNT(*) FILTER (WHERE used_in_training = TRUE)               AS used_in_training
      FROM nn_user_corrections
      GROUP BY model_name
    `),

    db.unsafe(`
      SELECT
        model_name,
        COUNT(*) AS total_predictions,
        COUNT(*) FILTER (WHERE valid_until > now())               AS active_predictions,
        COUNT(*) FILTER (WHERE valid_until < now())               AS stale_predictions,
        MIN(predicted_at)                                         AS oldest_prediction,
        MAX(predicted_at)                                         AS newest_prediction,
        COUNT(DISTINCT entity_id)                                 AS unique_entities
      FROM nn_prediction_cache
      WHERE predicted_at > now() - interval '7 days'
      GROUP BY model_name
    `),
  ]);

  const overall = systemStatus.every((m: any) => m.lifecycle === "live")
    ? "healthy"
    : systemStatus.some((m: any) => m.lifecycle === "live")
    ? "degraded"
    : "offline";

  return c.json({
    overall,
    models: systemStatus.map((m: any) => ({
      name: m.model_name,
      version: m.version ?? null,
      trained_at: m.trained_at ? new Date(m.trained_at).toISOString() : null,
      metrics: m.metrics ?? null,
      lifecycle: m.lifecycle,
      labeled_rows: Number(m.labeled_rows),
      total_rows: Number(m.total_rows),
      cached_embeddings: Number(m.cached_embeddings),
    })),
    training_runs: trainingRuns.map((r: any) => ({
      model: r.model_name,
      version: r.model_version,
      status: r.status,
      started_at: new Date(r.started_at).toISOString(),
      finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      rows_total: r.rows_total,
      rows_train: r.rows_train,
      rows_val: r.rows_val,
      epochs_run: r.epochs_run,
      final_loss: r.final_loss ? Number(r.final_loss) : null,
      final_metrics: r.final_metrics ?? null,
      error: r.error_message ?? null,
    })),
    feedback: recentFeedback.map((f: any) => ({
      model: f.model_name,
      corrections_24h: Number(f.corrections_24h),
      corrections_7d: Number(f.corrections_7d),
      corrections_30d: Number(f.corrections_30d),
      used_in_training: Number(f.used_in_training),
    })),
    cache: cacheStats.map((s: any) => ({
      model: s.model_name,
      total_predictions: Number(s.total_predictions),
      active_predictions: Number(s.active_predictions),
      stale_predictions: Number(s.stale_predictions),
      unique_entities: Number(s.unique_entities),
      oldest_prediction: s.oldest_prediction ? new Date(s.oldest_prediction).toISOString() : null,
      newest_prediction: s.newest_prediction ? new Date(s.newest_prediction).toISOString() : null,
    })),
    generated_at: new Date().toISOString(),
  });
});

// ── GET /api/nn/leaderboard ────────────────────────────────────────
// Article leaderboard powered by the NN ranking model.
// Reads from the pre-materialized nn_article_leaderboard_live table.
nnRoute.get("leaderboard", async (c) => {
  const db = getDb();
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 30), 1), 100);
  const bucket = c.req.query("bucket"); // 'hot' | 'trending' | 'rising' | null (all)
  const country = c.req.query("country");
  const eventType = c.req.query("event_type");
  const sessionId = c.req.query("session_id");

  let query = `
    SELECT
      l.article_id,
      l.nn_ranking_score,
      l.nn_bucket,
      l.classical_engagement,
      l.blended_score,
      l.trending_score,
      l.local_relevance,
      l.source_quality,
      l.freshness,
      l.velocity,
      l.audience_match,
      l.event_id,
      l.event_type,
      l.headline,
      l.source_id,
      l.source_name,
      l.source_country,
      l.published_at,
      l.fetched_at,
      l.event_lat,
      l.event_lng,
      l.event_country,
      l.event_place_name
    FROM nn_article_leaderboard_live l
    WHERE l.expires_at > now()
  `;
  const params: any[] = [];
  const conditions: string[] = [];

  if (bucket) {
    params.push(bucket);
    conditions.push(`l.nn_bucket = $${params.length}`);
  }
  if (country) {
    params.push(country.toUpperCase());
    conditions.push(`l.event_country = $${params.length}`);
  }
  if (eventType) {
    params.push(eventType);
    conditions.push(`l.event_type = $${params.length}`);
  }
  if (conditions.length) query += " AND " + conditions.join(" AND ");
  query += ` ORDER BY l.blended_score DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const rows = await db.unsafe(query, params);

  // If session_id is provided, also return per-user session features
  let session = null;
  if (sessionId) {
    const [sessRows] = await db.unsafe(`
      SELECT
        session_id, home_country, last_lat, last_lng,
        interactions_6h, interactions_24h,
        topic_vector, country_vector, category_vector, source_vector
      FROM nn_realtime_session
      WHERE session_id = $1
    `, sessionId);
    session = sessRows ?? null;
  }

  return c.json({
    items: rows.map((r: any) => ({
      article_id: Number(r.article_id),
      event_id: r.event_id ? Number(r.event_id) : null,
      headline: r.headline,
      source: {
        id: Number(r.source_id),
        name: r.source_name,
        country: r.source_country,
      },
      location: r.event_lat != null ? {
        lat: Number(r.event_lat),
        lng: Number(r.event_lng),
        country: r.event_country,
        place_name: r.event_place_name,
      } : null,
      published_at: r.published_at ? new Date(r.published_at).toISOString() : null,
      fetched_at: r.fetched_at ? new Date(r.fetched_at).toISOString() : null,
      scores: {
        nn_ranking: Number(r.nn_ranking_score),
        classical_engagement: Number(r.classical_engagement),
        blended: Number(r.blended_score),
        trending: Number(r.trending_score),
        local_relevance: Number(r.local_relevance),
        source_quality: Number(r.source_quality),
        freshness: Number(r.freshness),
        velocity: Number(r.velocity),
        audience_match: Number(r.audience_match),
      },
      bucket: r.nn_bucket,
    })),
    count: rows.length,
    session: session ? {
      home_country: session.home_country,
      last_location: session.last_lat != null ? {
        lat: Number(session.last_lat),
        lng: Number(session.last_lng),
      } : null,
      interactions_6h: Number(session.interactions_6h),
      interactions_24h: Number(session.interactions_24h),
    } : null,
    filters: { bucket, country, event_type: eventType },
    generated_at: new Date().toISOString(),
  });
});

// ── GET /api/nn/event/:id/related ──────────────────────────────────
// Related events for an event detail page, powered by the relationship model.
nnRoute.get("event/:id/related", async (c) => {
  const db = getDb();
  const eventId = Number(c.req.param("id"));
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 10), 1), 50);

  const [relationships, similarity] = await Promise.all([
    db.unsafe(`
      SELECT
        r.src_event_id,
        r.dst_event_id,
        r.edge_type,
        r.relation,
        r.score,
        r.model_version,
        r.predicted_at,
        ea.headline AS src_headline,
        eb.headline AS dst_headline,
        el.lat AS dst_lat, el.lng AS dst_lng,
        el.place_name AS dst_place, el.country AS dst_country
      FROM nn_event_relationships r
      JOIN news_events ea ON ea.id = r.src_event_id
      JOIN news_events eb ON eb.id = r.dst_event_id
      LEFT JOIN news_locations el ON el.id = eb.primary_location_id
      WHERE r.src_event_id = $1
        AND r.model_version = (
          SELECT version FROM nn_model_registry
          WHERE model_name = 'relationship' AND is_active LIMIT 1
        )
      ORDER BY r.score DESC
      LIMIT $2
    `, eventId, limit),

    db.unsafe(`
      SELECT
        esg.event_b AS event_id,
        esg.score,
        esg.rank,
        e.headline,
        e.event_type,
        l.lat, l.lng, l.place_name, l.country
      FROM nn_event_similarity_graph esg
      JOIN news_events e ON e.id = esg.event_b
      LEFT JOIN news_locations l ON l.id = e.primary_location_id
      WHERE esg.event_a = $1
        AND esg.score > 0.4
      ORDER BY esg.rank ASC
      LIMIT $2
    `, eventId, limit),
  ]);

  return c.json({
    relationships: {
      items: relationships.map((r: any) => ({
        event_id: Number(r.dst_event_id),
        edge_type: r.edge_type,
        relation: r.relation,
        score: Number(r.score),
        headline: r.dst_headline,
        location: r.dst_lat != null ? {
          lat: Number(r.dst_lat),
          lng: Number(r.dst_lng),
          place_name: r.dst_place,
          country: r.dst_country,
        } : null,
        model_version: r.model_version,
        predicted_at: new Date(r.predicted_at).toISOString(),
      })),
      count: relationships.length,
    },
    similar: {
      items: similarity.map((s: any) => ({
        event_id: Number(s.event_id),
        score: Number(s.score),
        rank: Number(s.rank),
        headline: s.headline,
        event_type: s.event_type,
        location: s.lat != null ? {
          lat: Number(s.lat),
          lng: Number(s.lng),
          place_name: s.place_name,
          country: s.country,
        } : null,
      })),
      count: similarity.length,
    },
  });
});

// ── GET /api/nn/coverage ───────────────────────────────────────────
// Coverage gap analysis powered by the coverage model.
nnRoute.get("coverage", async (c) => {
  const db = getDb();
  const region = c.req.query("region");
  const _mg = Number(c.req.query("min_gap") ?? 0);
  const minGap = Number.isFinite(_mg) ? _mg : 0;
  const _lim = Number(c.req.query("limit") ?? 20);
  const limit = Math.min(Math.max(Number.isFinite(_lim) ? _lim : 20, 1), 100);

  let params: any[] = [];
  let regionFilter = "";
  if (region) {
    params.push(region);
    regionFilter = ` AND c.region = $${params.length}`;
  }

  const rows = await db.unsafe(`
    SELECT
      pc.entity_id,
      pc.score AS nn_gap_score,
      (pc.score_aux->>'confidence')::float    AS nn_confidence,
      (pc.score_aux->>'reasoning')::text      AS nn_reasoning,
      (pc.score_aux->>'recommended_sources')::int AS recommended_sources,
      g.country_code, g.country_name,
      g.population, g.active_sources,
      g.articles_24h, g.events_24h,
      g.gap_score AS classical_gap_score,
      g.events_per_million_24h,
      gz.lat, gz.lng, gz.label AS anchor_city,
      NULL::text AS region -- country_regions table does not exist in prod (FIX_NOTES 4.23)
    FROM nn_prediction_cache pc
    JOIN nn_model_registry r ON r.model_name = pc.model_name AND r.is_active = TRUE
    JOIN news_coverage_gaps g ON g.id = pc.entity_id
    -- FIX_NOTES 4.23: joined world_cities.iso_alpha2/.place_name — columns
    -- the FDW mapping does not have — so this endpoint 500'd on every
    -- request; the remote scan would also have run per row. The local
    -- gazetteer is the correct anchor.
    LEFT JOIN gazetteer gz ON gz.id = (
      SELECT id FROM gazetteer
      WHERE country_code = g.country_code
      ORDER BY importance DESC NULLS LAST LIMIT 1
    )
    WHERE pc.model_name = 'coverage'
      AND pc.entity_type = 'country'
      AND pc.valid_until > now()
      ${regionFilter}
    ORDER BY pc.score DESC
    LIMIT $${params.length + 1}
  `, [...params, limit]);

  return c.json({
    items: rows.map((r: any) => ({
      country_code: r.country_code,
      country_name: r.country_name,
      region: r.region,
      population: Number(r.population),
      active_sources: Number(r.active_sources),
      articles_24h: Number(r.articles_24h),
      events_24h: Number(r.events_24h),
      events_per_million: Number(r.events_per_million_24h),
      nn_gap_score: Number(r.nn_gap_score),
      classical_gap_score: Number(r.classical_gap_score),
      nn_confidence: r.nn_confidence ? Number(r.nn_confidence) : null,
      nn_reasoning: r.nn_reasoning ?? null,
      recommended_sources: r.recommended_sources ?? 0,
      location: r.lat != null ? { lat: Number(r.lat), lng: Number(r.lng) } : null,
    })),
    count: rows.length,
    filters: { region, min_gap: minGap },
    generated_at: new Date().toISOString(),
  });
});

// ── POST /api/nn/feedback ─────────────────────────────────────────
// Submit user correction feedback on an NN prediction.
nnRoute.post("feedback", async (c) => {
  const db = getDb();
  const body = await c.req.json();

  const {
    model_name,
    article_id,
    event_id,
    entity_type,
    entity_id,
    correction_type,
    original,
    corrected,
    session_id,
    user_lat,
    user_lng,
    user_country,
  } = body;

  if (!model_name || !correction_type || !entity_type || !entity_id) {
    return c.json({ error: "missing_required_fields" }, 400);
  }

  const rows = await db.unsafe(`
    INSERT INTO nn_user_corrections (
      model_name, article_id, event_id, entity_type, entity_id,
      correction_type,
      original_score, original_lat, original_lng, original_country, original_precision,
      corrected_score, corrected_lat, corrected_lng, corrected_country, corrected_precision,
      session_id, user_lat, user_lng, user_country,
      ip_address, user_agent, metadata
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11,
      $12, $13, $14, $15, $16,
      $17, $18, $19, $20,
      $21, $22, $23
    )
    RETURNING id
  `,
    model_name,
    article_id ?? null,
    event_id ?? null,
    entity_type,
    entity_id,
    correction_type,
    original?.score ?? null,
    original?.lat ?? null,
    original?.lng ?? null,
    original?.country ?? null,
    original?.precision ?? null,
    corrected?.score ?? null,
    corrected?.lat ?? null,
    corrected?.lng ?? null,
    corrected?.country ?? null,
    corrected?.precision ?? null,
    session_id ?? null,
    user_lat ?? null,
    user_lng ?? null,
    user_country ?? null,
    c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? null,
    c.req.header("user-agent") ?? null,
    JSON.stringify({ source: "nn-feedback-api" }),
  );

  // Also write to nn_feedback for training pipeline
  await db.unsafe(`
    INSERT INTO nn_feedback (
      model_name, feedback_target_type, feedback_target_id, kind,
      weight, label, label_aux, session_id,
      user_lat, user_lng, user_country,
      ip_address, user_agent, metadata
    ) VALUES (
      $1, $2, $3, 'override',
      1.0, $4, $5, $6,
      $7, $8, $9, $10, $11, $12
    )
  `,
    model_name,
    entity_type,
    entity_id,
    corrected?.score ?? corrected?.lat ?? null,
    JSON.stringify({ original, corrected, correction_type }),
    session_id ?? null,
    user_lat ?? null,
    user_lng ?? null,
    user_country ?? null,
    c.req.header("x-forwarded-for") ?? null,
    c.req.header("user-agent") ?? null,
    JSON.stringify({ correction_type }),
  );

  return c.json({ ok: true, id: Number(rows[0].id) });
});

// ── GET /api/nn/drift ─────────────────────────────────────────────
// Model drift report: shows score distribution changes over time.
nnRoute.get("drift", async (c) => {
  const db = getDb();
  // Default to "coverage": it is the only model whose prediction cache is
  // still populated (1.3M rows). The old default, "geolocation", pointed
  // at a model that was removed on 2026-10-26 — it never placed an
  // article, so the drift panel was permanently empty.
  const model = c.req.query("model") ?? "coverage";
  const windowHours = Math.min(Math.max(Number(c.req.query("window_hours") ?? 24), 1), 168);

  const [scoreHistory, correctionDrift] = await Promise.all([
    db.unsafe(`
      SELECT
        model_name, model_version,
        DATE_TRUNC('hour', predicted_at) AS hour,
        AVG(score) AS avg_score,
        STDDEV(score) AS std_score,
        MIN(score) AS min_score,
        MAX(score) AS max_score,
        COUNT(*) AS sample_count
      FROM nn_score_history
      WHERE model_name = $1
        AND predicted_at > now() - interval '${windowHours} hours'
      GROUP BY 1, 2, 3
      ORDER BY hour ASC
    `, model),

    db.unsafe(`
      SELECT
        model_name,
        DATE_TRUNC('hour', created_at) AS hour,
        COUNT(*) AS correction_count,
        AVG(corrected_lat - original_lat) FILTER (WHERE original_lat IS NOT NULL) AS avg_lat_shift,
        AVG(corrected_lng - original_lng) FILTER (WHERE original_lng IS NOT NULL) AS avg_lng_shift
      FROM nn_user_corrections
      WHERE model_name = $1
        AND created_at > now() - interval '${windowHours} hours'
      GROUP BY 1, 2
      ORDER BY hour ASC
    `, model),
  ]);

  return c.json({
    model,
    window_hours: windowHours,
    score_history: scoreHistory.map((s: any) => ({
      hour: new Date(s.hour).toISOString(),
      avg_score: Number(s.avg_score),
      std_score: Number(s.std_score) || 0,
      min_score: Number(s.min_score),
      max_score: Number(s.max_score),
      sample_count: Number(s.sample_count),
    })),
    correction_drift: correctionDrift.map((d: any) => ({
      hour: new Date(d.hour).toISOString(),
      correction_count: Number(d.correction_count),
      avg_lat_shift: d.avg_lat_shift ? Number(d.avg_lat_shift) : null,
      avg_lng_shift: d.avg_lng_shift ? Number(d.avg_lng_shift) : null,
    })),
    generated_at: new Date().toISOString(),
  });
});

// ── GET /api/nn/similar ────────────────────────────────────────────
// Find similar articles using pre-computed embedding similarity.
nnRoute.get("similar", async (c) => {
  const db = getDb();
  const articleId = Number(c.req.query("article_id"));
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 10), 1), 50);

  if (!articleId) return c.json({ error: "article_id required" }, 400);

  const rows = await db.unsafe(`
    SELECT
      ae2.article_id,
      l.article_id IS NOT NULL AS shared_event,
      1 - (ae1.vector <=> ae2.vector) AS cosine_sim,
      a.title, a.published_at,
      s.name AS source_name, s.country AS source_country,
      l.lat, l.lng, l.place_name, l.country AS location_country
    FROM nn_article_embeddings ae1
    JOIN nn_article_embeddings ae2
      ON ae2.model_version = ae1.model_version
     AND ae2.article_id != ae1.article_id
    JOIN news_articles a ON a.id = ae2.article_id
    LEFT JOIN news_sources s ON s.id = a.source_id
    LEFT JOIN news_locations l ON l.id = a.location_id
    LEFT JOIN news_event_sources es1 ON es1.article_id = ae1.article_id
    LEFT JOIN news_event_sources es2 ON es2.article_id = ae2.article_id
    WHERE ae1.article_id = $1
      AND ae1.model_version = (
        SELECT version FROM nn_model_registry
        WHERE model_name = 'article_understanding' AND is_active LIMIT 1
      )
      -- Tier 1.4: filter retired sources so they don't leak into public listings.
      AND s.deleted_at IS NULL
    ORDER BY ae1.vector <=> ae2.vector
    LIMIT $2
  `, articleId, limit);

  return c.json({
    article_id: articleId,
    items: rows.map((r: any) => ({
      article_id: Number(r.article_id),
      cosine_similarity: Number(r.cosine_sim),
      title: r.title,
      published_at: r.published_at ? new Date(r.published_at).toISOString() : null,
      source: { name: r.source_name, country: r.source_country },
      shared_event: Boolean(r.shared_event),
      location: r.lat != null ? {
        lat: Number(r.lat), lng: Number(r.lng),
        place_name: r.place_name, country: r.location_country,
      } : null,
    })),
    count: rows.length,
  });
});

// ── POST /api/nn/refresh ─────────────────────────────────────────────────────
// Fire-and-forget trigger for the NN inference + leaderboard refresh pipeline.
// Runs as a detached Python subprocess so the HTTP response returns immediately.
// The worker processes articles in batches and writes results to the DB.
nnRoute.post("refresh", async (c) => {
  // FIX_NOTES 2.2: this spawned a detached Python inference subprocess
  // per request with no auth and no rate limit — a trivial CPU DoS. The
  // nn-infer systemd timer is the legitimate driver; HTTP trigger is
  // operator-facing now.
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 500), 1), 2000);
  const enqueue = c.req.query("enqueue") !== "false";

  const child = spawn(
    "/usr/bin/python3.11",
    [
      "-m", "worker.nn_infer",
      "--limit", String(limit),
      ...(enqueue ? ["--enqueue"] : []),
    ],
    {
      cwd: WORKER_CWD,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();

  return c.json({
    ok: true,
    message: "NN inference pipeline started",
    limit,
    enqueue,
    generated_at: new Date().toISOString(),
  });
});
