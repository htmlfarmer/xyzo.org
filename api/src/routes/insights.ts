import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb } from "../db";

export const insightsRoute = new Hono();

const LimitSchema = z.object({ limit: z.coerce.number().min(1).max(100).default(20) });

const LocationTermsSchema = z.object({
  location_id: z.coerce.number(),
  min_tfidf: z.coerce.number().default(0.01),
  limit: z.coerce.number().min(1).max(100).default(20),
});

const TermAssociationsSchema = z.object({
  term: z.string().min(2),
  limit: z.coerce.number().min(1).max(50).default(20),
});

// ── GET /api/insights/location/:id/terms ─────────────────────────────────
//
// Returns distinctive terms (TF-IDF) for a location.
// This answers: "What topics is this location known for?"
//
insightsRoute.get(
  "/insights/location/:id/terms",
  zValidator("query", LocationTermsSchema),
  async (c) => {
    const { location_id, min_tfidf, limit } = c.req.valid("query");
    const sql = getDb();

    const rows = await sql<Array<{
      term: string;
      tfidf: number;
      tf: number;
      idf: number;
      term_count: number;
      entropy: number;
      article_count: number;
    }>>`
      SELECT 
        lt.term,
        lt.tfidf,
        lt.tf,
        lt.idf,
        lt.term_count,
        lt.entropy,
        lt.article_count
      FROM news_location_terms lt
      WHERE lt.location_id = ${location_id}
        AND lt.tfidf >= ${min_tfidf}
      ORDER BY lt.tfidf DESC
      LIMIT ${limit}
    `;

    return c.json({ 
      items: rows,
      count: rows.length,
      location_id,
    });
  }
);

// ── GET /api/insights/event/:id/stats ─────────────────────────────────────
//
// Returns quantitative statistics for an event:
// - burst_score: spike detection (0 = normal, >1 = burst)
// - z_score: standard deviations from mean
// - percentile: ranking vs historical
// - velocity: articles per hour
// - novelty: how different from past coverage
// - source_independence: ratio of original vs syndicated sources
//
insightsRoute.get(
  "/insights/event/:id/stats",
  zValidator("param", z.object({ id: z.coerce.number() })),
  async (c) => {
    const { id } = c.req.valid("param");
    const sql = getDb();

    const rows = await sql<Array<{
      event_id: number;
      article_count_1h: number;
      article_count_6h: number;
      article_count_24h: number;
      article_count_7d: number;
      unique_sources_24h: number;
      original_sources_24h: number;
      syndicated_copies_24h: number;
      countries_24h: number;
      cities_24h: number;
      geographic_spread_km: number;
      time_span_hours: number;
      velocity_1h: number;
      velocity_6h: number;
      velocity_24h: number;
      acceleration: number;
      burst_score: number;
      z_score: number;
      percentile: number;
      novelty_score: number;
      source_independence_score: number;
      computed_at: Date;
    }>>`
      SELECT 
        es.event_id,
        es.article_count_1h,
        es.article_count_6h,
        es.article_count_24h,
        COALESCE(
          (SELECT COUNT(DISTINCT a.id)::float
           FROM news_articles a 
           JOIN news_event_sources es2 ON es2.article_id = a.id 
           WHERE es2.event_id = ${id} 
           AND a.fetched_at > NOW() - INTERVAL '7 days')
        , 0) as article_count_7d,
        es.unique_sources_24h,
        es.original_sources_24h,
        es.syndicated_copies_24h,
        es.countries_24h,
        es.cities_24h,
        es.geographic_spread_km,
        es.time_span_hours,
        es.velocity_1h,
        es.velocity_6h,
        es.velocity_24h,
        es.acceleration,
        es.burst_score,
        es.z_score,
        es.percentile,
        es.novelty_score,
        es.source_independence_score,
        es.computed_at
      FROM news_event_stats es
      WHERE es.event_id = ${id}
    `;

    if (rows.length === 0) {
      return c.json({ 
        error: "not_found",
        message: "Event stats not computed yet",
        event_id: id,
        stats: null,
      });
    }

    const row = rows[0];

    return c.json({
      event_id: id,
      stats: {
        frequency: {
          articles_1h: row.article_count_1h,
          articles_6h: row.article_count_6h,
          articles_24h: row.article_count_24h,
          articles_7d: Number(row.article_count_7d),
        },
        velocity: {
          current: row.velocity_24h,
          per_hour_1h: row.velocity_1h,
          per_hour_6h: row.velocity_6h,
          acceleration: row.acceleration,
        },
        geography: {
          countries: row.countries_24h,
          cities: row.cities_24h,
          spread_km: row.geographic_spread_km,
        },
        detection: {
          burst_score: row.burst_score,
          z_score: row.z_score,
          percentile: row.percentile,
          novelty: row.novelty_score,
        },
        sources: {
          unique_24h: row.unique_sources_24h,
          originals: row.original_sources_24h,
          syndicated: row.syndicated_copies_24h,
          independence: row.source_independence_score,
        },
        temporal: {
          time_span_hours: row.time_span_hours,
          computed_at: row.computed_at,
        },
      },
    });
  }
);

// ── GET /api/insights/event/:id/pulse ─────────────────────────────────────
//
// Lightweight endpoint for map overlays - just the key metrics needed
// for coloring pins by activity level.
//
insightsRoute.get(
  "/insights/event/:id/pulse",
  zValidator("param", z.object({ id: z.coerce.number() })),
  async (c) => {
    const { id } = c.req.valid("param");
    const sql = getDb();

    const rows = await sql<Array<{
      event_id: number;
      articles_1h: number;
      articles_6h: number;
      articles_24h: number;
      velocity_score: number;
      emerging_score: number;
      burst_score: number;
      z_score: number;
      geographic_spread_km: number;
    }>>`
      SELECT 
        v.event_id,
        v.articles_1h,
        v.articles_6h,
        v.articles_24h,
        v.velocity_score,
        v.emerging_score,
        COALESCE(es.burst_score, 0) as burst_score,
        COALESCE(es.z_score, 0) as z_score,
        COALESCE(es.geographic_spread_km, v.geographic_spread_km, 0) as geographic_spread_km
      FROM news_event_velocity v
      LEFT JOIN news_event_stats es ON es.event_id = v.event_id
      WHERE v.event_id = ${id}
    `;

    if (rows.length === 0) {
      return c.json({ 
        event_id: id,
        pulse: null,
      });
    }

    const row = rows[0];

    return c.json({
      event_id: id,
      pulse: {
        articles_1h: row.articles_1h,
        articles_6h: row.articles_6h,
        articles_24h: row.articles_24h,
        velocity_score: row.velocity_score,
        emerging_score: row.emerging_score,
        burst_score: row.burst_score,
        z_score: row.z_score,
        geographic_spread_km: row.geographic_spread_km,
      },
    });
  }
);

// ── GET /api/insights/terms/associations ──────────────────────────────────
//
// Returns term associations based on PMI (Pointwise Mutual Information).
// This answers: "What terms commonly appear together?"
//
insightsRoute.get(
  "/insights/terms/associations",
  zValidator("query", TermAssociationsSchema),
  async (c) => {
    const { term, limit } = c.req.valid("query");
    const sql = getDb();

    const rows = await sql<Array<{
      term1: string;
      term2: string;
      co_count: number;
      pmi: number;
      npmi: number;
    }>>`
      SELECT 
        tp.term1,
        tp.term2,
        tp.co_count,
        tp.pmi,
        tp.npmi
      FROM news_term_pairs tp
      WHERE LOWER(tp.term1) = LOWER(${term})
         OR LOWER(tp.term2) = LOWER(${term})
      ORDER BY tp.pmi DESC
      LIMIT ${limit}
    `;

    return c.json({ 
      items: rows.map(r => ({
        term: r.term1.toLowerCase() === term.toLowerCase() ? r.term2 : r.term1,
        co_count: r.co_count,
        pmi: r.pmi,
        npmi: r.npmi,
      })),
      count: rows.length,
      query_term: term,
    });
  }
);

// ── GET /api/insights/trending ─────────────────────────────────────────────
//
// Returns trending events based on velocity, burst, and emerging scores.
// This answers: "What's happening right now?"
//
insightsRoute.get(
  "/insights/trending",
  zValidator("query", LimitSchema),
  async (c) => {
    const { limit } = c.req.valid("query");
    const sql = getDb();

    const rows = await sql<Array<{
      event_id: string;
      headline: string;
      event_type: string;
      source_count: string;
      articles_1h: number;
      articles_24h: number;
      velocity_score: number;
      emerging_score: number;
      burst_score: number;
      countries_24h: number;
      city_name: string | null;
      lat: number | null;
      lng: number | null;
    }>>`
      SELECT 
        e.id::text as event_id,
        e.headline,
        e.event_type,
        e.source_count::text,
        v.articles_1h,
        v.articles_24h,
        v.velocity_score,
        v.emerging_score,
        COALESCE(es.burst_score, 0) as burst_score,
        v.countries_24h,
        l.place_name as city_name,
        l.lat,
        l.lng
      FROM news_events e
      JOIN news_event_velocity v ON v.event_id = e.id
      LEFT JOIN news_event_stats es ON es.event_id = e.id
      LEFT JOIN news_locations l ON l.id = e.primary_location_id
      WHERE e.status = 'active'
      ORDER BY 
        v.velocity_score DESC,
        v.articles_24h DESC,
        es.burst_score DESC NULLS LAST
      LIMIT ${limit}
    `;

    return c.json({ 
      items: rows.map(r => ({
        ...r,
        event_id: Number(r.event_id),
        source_count: Number(r.source_count),
      })),
      count: rows.length,
    });
  }
);

// ── GET /api/insights/discovery ────────────────────────────────────────────
//
// Returns distinctive topics per continent/country/city using TF-IDF.
// This answers: "What's distinctive about this place?"
//
insightsRoute.get(
  "/insights/discovery",
  zValidator("query", z.object({
    location_id: z.coerce.number().optional(),
    country: z.string().optional(),
    bbox: z.string().optional(), // "minLng,minLat,maxLng,maxLat"
    limit: z.coerce.number().min(1).max(50).default(10),
  })),
  async (c) => {
    const { location_id, country, bbox, limit } = c.req.valid("query");
    const sql = getDb();

    let rows;

    if (location_id) {
      rows = await sql<Array<{
        term: string;
        tfidf: number;
        term_count: number;
        entropy: number;
      }>>`
        SELECT
          lt.term,
          lt.tfidf,
          lt.term_count,
          lt.entropy
        FROM news_location_terms lt
        WHERE lt.location_id = ${location_id}
          AND lt.tfidf > 0.01
        ORDER BY lt.tfidf DESC
        LIMIT ${limit}
      `;
    } else if (country) {
      rows = await sql<Array<{
        term: string;
        tfidf: number;
        term_count: number;
        entropy: number;
      }>>`
        SELECT
          lt.term,
          lt.tfidf,
          lt.term_count,
          lt.entropy
        FROM news_location_terms lt
        JOIN news_locations l ON l.id = lt.location_id
        WHERE l.country = ${country.toUpperCase()}
          AND lt.tfidf > 0.01
        ORDER BY lt.tfidf DESC
        LIMIT ${limit}
      `;
    } else if (bbox) {
      const [minLng, minLat, maxLng, maxLat] = bbox.split(",").map(Number);
      rows = await sql<Array<{
        term: string;
        tfidf: number;
        term_count: number;
        entropy: number;
      }>>`
        SELECT
          lt.term,
          lt.tfidf,
          lt.term_count,
          lt.entropy
        FROM news_location_terms lt
        JOIN news_locations l ON l.id = lt.location_id
        WHERE l.geom::geometry && ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)
          AND lt.tfidf > 0.01
        ORDER BY lt.tfidf DESC
        LIMIT ${limit}
      `;
    } else {
      return c.json({ error: "Must provide location_id, country, or bbox" }, 400);
    }

    return c.json({
      items: rows,
      count: rows.length,
    });
  }
);

// ── GET /api/insights/article/:id ────────────────────────────────────────────
//
// Returns all NLP features for a single article.
// This answers: "What structured information can we extract from this article?"
//
insightsRoute.get(
  "/insights/article/:id",
  zValidator("param", z.object({ id: z.coerce.number() })),
  async (c) => {
    const { id } = c.req.valid("param");
    const sql = getDb();

    const rows = await sql<Array<{
      article_id: number;
      temporal_features: object | null;
      quantity_features: object | null;
      entity_features: object | null;
      claim_features: object | null;
      attribution_features: object | null;
      linguistic_features: object | null;
    }>>`
      SELECT
        af.article_id,
        af.temporal_features,
        af.quantity_features,
        af.entity_features,
        af.claim_features,
        af.attribution_features,
        af.linguistic_features
      FROM article_facts af
      WHERE af.article_id = ${id}
    `;

    if (rows.length === 0) {
      return c.json({
        error: "not_found",
        message: "Article not found or NLP features not yet computed",
        article_id: id,
      }, 404);
    }

    const row = rows[0];

    return c.json({
      article_id: id,
      features: {
        temporal: row.temporal_features,
        quantities: row.quantity_features,
        entities: row.entity_features,
        claims: row.claim_features,
        attribution: row.attribution_features,
        linguistic: row.linguistic_features,
      },
    });
  }
);

// ── GET /api/insights/location/:id/nlp ────────────────────────────────────────
//
// Returns aggregated NLP features for all articles at a location.
// This answers: "What are the NLP characteristics of coverage at this location?"
//
insightsRoute.get(
  "/insights/location/:id/nlp",
  zValidator("param", z.object({ id: z.coerce.number() })),
  async (c) => {
    const { id } = c.req.valid("param");
    const sql = getDb();

    const countRows = await sql<Array<{ count: number }>>`
      SELECT COUNT(*)::float as count
      FROM article_facts af
      JOIN news_articles a ON a.id = af.article_id
      WHERE a.location_id = ${id}
        AND af.temporal_features IS NOT NULL
    `;

    // Number() matters twice here: COUNT(*) arrives as BigInt without the
    // ::float cast, and `BigInt === 0` is ALWAYS false — the early-return
    // below silently never fired before this fix.
    const articleCount = Number(countRows[0]?.count ?? 0);

    if (articleCount === 0) {
      return c.json({
        location_id: id,
        article_count: 0,
        error: "No NLP features computed for this location yet",
      });
    }

    const tempRows = await sql<Array<{ temporal_class: string; count: number }>>`
      SELECT
        COALESCE((af.temporal_features->>'temporal_class'), 'unknown') as temporal_class,
        COUNT(*) as count
      FROM article_facts af
      JOIN news_articles a ON a.id = af.article_id
      WHERE a.location_id = ${id}
        AND af.temporal_features IS NOT NULL
      GROUP BY temporal_class
    `;

    const claimRows = await sql<Array<{ claim_type: string; total: number }>>`
      SELECT
        key as claim_type,
        SUM(value::int) as total
      FROM article_facts af
      JOIN news_articles a ON a.id = af.article_id,
           jsonb_each_text(COALESCE(af.claim_features->'claim_types', '{}'))
      WHERE a.location_id = ${id}
        AND af.claim_features IS NOT NULL
      GROUP BY key
    `;

    const attrRows = await sql<Array<{
      official: number;
      expert: number;
      witness: number;
      company: number;
      anonymous: number;
    }>>`
      SELECT
        SUM(COALESCE((af.attribution_features->>'official_source_count')::int, 0)) as official,
        SUM(COALESCE((af.attribution_features->>'expert_source_count')::int, 0)) as expert,
        SUM(COALESCE((af.attribution_features->>'witness_source_count')::int, 0)) as witness,
        SUM(COALESCE((af.attribution_features->>'company_source_count')::int, 0)) as company,
        SUM(COALESCE((af.attribution_features->>'anonymous_source_count')::int, 0)) as anonymous
      FROM article_facts af
      JOIN news_articles a ON a.id = af.article_id
      WHERE a.location_id = ${id}
        AND af.attribution_features IS NOT NULL
    `;

    const entityRows = await sql<Array<{
      total: number;
      unique: number;
      persons: number;
      orgs: number;
    }>>`
      SELECT
        SUM(COALESCE((af.entity_features->>'entity_count')::int, 0)) as total,
        SUM(COALESCE((af.entity_features->>'unique_entity_count')::int, 0)) as unique,
        SUM(COALESCE((af.entity_features->>'person_count')::int, 0)) as persons,
        SUM(COALESCE((af.entity_features->>'organization_count')::int, 0)) as orgs
      FROM article_facts af
      JOIN news_articles a ON a.id = af.article_id
      WHERE a.location_id = ${id}
        AND af.entity_features IS NOT NULL
    `;

    const lingRows = await sql<Array<{
      avg_word_count: number;
      avg_entropy: number;
      avg_ttr: number;
    }>>`
      SELECT
        AVG(COALESCE((af.linguistic_features->>'word_count')::numeric, 0)) as avg_word_count,
        AVG(COALESCE((af.linguistic_features->>'lexical_entropy')::numeric, 0)) as avg_entropy,
        AVG(COALESCE((af.linguistic_features->>'type_token_ratio')::numeric, 0)) as avg_ttr
      FROM article_facts af
      JOIN news_articles a ON a.id = af.article_id
      WHERE a.location_id = ${id}
        AND af.linguistic_features IS NOT NULL
    `;

    const temporal_distribution: Record<string, number> = {};
    for (const r of tempRows) temporal_distribution[r.temporal_class] = Number(r.count);

    const claim_types: Record<string, number> = {};
    for (const r of claimRows) claim_types[r.claim_type] = Number(r.total);

    const attr = attrRows[0];
    const attribution_breakdown = attr ? {
      official: Number(attr.official),
      expert: Number(attr.expert),
      witness: Number(attr.witness),
      company: Number(attr.company),
      anonymous: Number(attr.anonymous),
    } : { official: 0, expert: 0, witness: 0, company: 0, anonymous: 0 };

    const ent = entityRows[0];
    const entity_stats = ent ? {
      total: Number(ent.total),
      unique: Number(ent.unique),
      persons: Number(ent.persons),
      orgs: Number(ent.orgs),
    } : { total: 0, unique: 0, persons: 0, orgs: 0 };

    const ling = lingRows[0];
    const linguistic_stats = ling ? {
      avg_word_count: Number(ling.avg_word_count),
      avg_entropy: Number(ling.avg_entropy),
      avg_ttr: Number(ling.avg_ttr),
    } : { avg_word_count: 0, avg_entropy: 0, avg_ttr: 0 };

    return c.json({
      location_id: id,
      article_count: Number(articleCount),
      temporal_distribution,
      claim_types,
      attribution_breakdown,
      entity_stats,
      linguistic_stats,
    });
  }
);

// ── GET /api/insights/search ───────────────────────────────────────────────────
//
// Search articles by claim predicates, entity types, temporal modes.
// This answers: "Show me all articles where someone PLANNED something in Indonesia"
//
insightsRoute.get(
  "/insights/search",
  zValidator("query", z.object({
    predicate: z.string().optional(),
    entity_type: z.string().optional(),
    temporal_class: z.string().optional(),
    location_id: z.coerce.number().optional(),
    country: z.string().optional(),
    bbox: z.string().optional(),
    min_entropy: z.coerce.number().optional(),
    limit: z.coerce.number().min(1).max(100).default(20),
    offset: z.coerce.number().min(0).default(0),
  })),
  async (c) => {
    const { predicate, temporal_class, location_id, country, bbox, min_entropy, limit, offset } = c.req.valid("query");
    const sql = getDb();

    let params: any[] = [];
    let paramIdx = 1;

    let baseQuery = `
      FROM article_facts af
      JOIN news_articles a ON a.id = af.article_id
      LEFT JOIN news_locations l ON l.id = a.location_id
      WHERE af.temporal_features IS NOT NULL AND af.claim_features IS NOT NULL
    `;

    if (predicate) {
      baseQuery += ` AND af.claim_features->'claim_types'->>$${paramIdx} IS NOT NULL`;
      params.push(predicate);
      paramIdx++;
    }

    if (temporal_class) {
      baseQuery += ` AND af.temporal_features->>'temporal_class' = $${paramIdx}`;
      params.push(temporal_class);
      paramIdx++;
    }

    if (min_entropy !== undefined) {
      baseQuery += ` AND (af.linguistic_features->>'lexical_entropy')::numeric >= $${paramIdx}`;
      params.push(min_entropy);
      paramIdx++;
    }

    if (location_id) {
      baseQuery += ` AND a.location_id = $${paramIdx}`;
      params.push(location_id);
      paramIdx++;
    } else if (country) {
      baseQuery += ` AND l.country = $${paramIdx}`;
      params.push(country.toUpperCase());
      paramIdx++;
    } else if (bbox) {
      const [minLng, minLat, maxLng, maxLat] = bbox.split(",").map(Number);
      baseQuery += ` AND l.geom::geometry && ST_MakeEnvelope($${paramIdx}, $${paramIdx+1}, $${paramIdx+2}, $${paramIdx+3}, 4326)`;
      params.push(minLng, minLat, maxLng, maxLat);
      paramIdx += 4;
    }

    const selectQuery = `SELECT a.id as article_id, a.title, af.temporal_features->>'temporal_class' as temporal_class, af.claim_features->'claim_types' as claim_types, COALESCE((af.entity_features->>'entity_count')::int, 0) as entity_count, COALESCE((af.linguistic_features->>'lexical_entropy')::numeric, 0) as lexical_entropy ${baseQuery}`;
    const countQuery = `SELECT COUNT(*) as count ${baseQuery}`;

    params.push(limit, offset);
    const fullQuery = `${selectQuery} ORDER BY af.temporal_features->>'temporal_class' DESC, af.linguistic_features->>'lexical_entropy' DESC NULLS LAST LIMIT $${paramIdx} OFFSET $${paramIdx+1}`;

    const rows = await sql.unsafe(fullQuery, params);
    const countResult = await sql.unsafe(countQuery, params.slice(0, -2));
    const total = Number(countResult[0]?.count ?? 0);

    return c.json({
      items: rows.map(r => ({
        ...r,
        article_id: Number(r.article_id),
        entity_count: Number(r.entity_count),
        lexical_entropy: Number(r.lexical_entropy),
      })),
      count: rows.length,
      total,
      query: { predicate, temporal_class, location_id, country, bbox, min_entropy },
    });
  }
);

// ── GET /api/insights/kg/entity/:name ───────────────────────────────────────────
//
// Returns all claims involving an entity (as subject or object).
// This answers: "What do we know about X?"
//
insightsRoute.get(
  "/insights/kg/entity/:name",
  zValidator("param", z.object({ name: z.string().min(1) })),
  zValidator("query", z.object({
    limit: z.coerce.number().min(1).max(100).default(20),
  })),
  async (c) => {
    const { name } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    const sql = getDb();

    const rows = await sql<Array<{
      subject_name: string;
      predicate: string;
      object_name: string;
      article_id: number;
      certainty: string;
      published_at: Date | null;
    }>>`
      SELECT
        sn.name as subject_name,
        ke.predicate,
        on_.name as object_name,
        ke.article_id,
        ke.certainty,
        ke.published_at
      FROM kg_edges ke
      JOIN kg_nodes sn ON sn.id = ke.subject_id
      JOIN kg_nodes on_ ON on_.id = ke.object_id
      WHERE LOWER(sn.name) = LOWER(${name})
         OR LOWER(on_.name) = LOWER(${name})
      ORDER BY ke.published_at DESC NULLS LAST
      LIMIT ${limit}
    `;

    const as_subject = rows.filter(r => r.subject_name.toLowerCase() === name.toLowerCase());
    const as_object = rows.filter(r => r.object_name.toLowerCase() === name.toLowerCase());

    return c.json({
      entity: name,
      as_subject_count: as_subject.length,
      as_object_count: as_object.length,
      as_subject: as_subject.map(r => ({
        predicate: r.predicate,
        object: r.object_name,
        article_id: Number(r.article_id),
        certainty: r.certainty,
        published_at: r.published_at,
      })),
      as_object: as_object.map(r => ({
        subject: r.subject_name,
        predicate: r.predicate,
        article_id: Number(r.article_id),
        certainty: r.certainty,
        published_at: r.published_at,
      })),
    });
  }
);

// ── GET /api/insights/kg/predicate/:predicate ──────────────────────────────────
//
// Returns all edges with a given predicate.
// This answers: "Show me all PLANNED events"
//
insightsRoute.get(
  "/insights/kg/predicate/:predicate",
  zValidator("param", z.object({ predicate: z.string().min(1) })),
  zValidator("query", z.object({
    limit: z.coerce.number().min(1).max(100).default(20),
  })),
  async (c) => {
    const { predicate } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    const sql = getDb();

    const rows = await sql<Array<{
      subject_name: string;
      predicate: string;
      object_name: string;
      article_id: number;
      certainty: string;
    }>>`
      SELECT
        sn.name as subject_name,
        ke.predicate,
        on_.name as object_name,
        ke.article_id,
        ke.certainty
      FROM kg_edges ke
      JOIN kg_nodes sn ON sn.id = ke.subject_id
      JOIN kg_nodes on_ ON on_.id = ke.object_id
      WHERE ke.predicate = ${predicate}
      ORDER BY ke.created_at DESC
      LIMIT ${limit}
    `;

    return c.json({
      predicate,
      count: rows.length,
      edges: rows.map(r => ({
        subject: r.subject_name,
        object: r.object_name,
        article_id: Number(r.article_id),
        certainty: r.certainty,
      })),
    });
  }
);
