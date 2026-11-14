import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getDb } from "../db";
import { RateLimiter, getClientIp } from "../ratelimit";
import { assertSafeUrl, BlockedUrlError } from "../lib/ssrf";

export const newsRoute = new Hono();

// ── Rate limiters ──────────────────────────────────────────────────────
// Submissions are queued for human review, so keep the budget tight:
// 10/hour/IP stops spam and limits SSRF-probe volume through assertSafeUrl.
const submitLimiter = new RateLimiter({ max: 10, windowMs: 60 * 60 * 1000 });
// Recommendations are cheap integer increments, but still bounded.
const recommendLimiter = new RateLimiter({ max: 30, windowMs: 60 * 60 * 1000 });

const SubmitNewsSchema = z.object({
  url: z.string().trim().min(8).max(2048),
  title: z.string().trim().max(300).optional(),
  note: z.string().trim().max(1000).optional(),
  session_id: z.string().max(100).optional(),
});

const RecommendSchema = z
  .object({
    session_id: z.string().max(100).optional(),
  })
  .optional();

function sanitizeIp(ip: string): string | null {
  return ip && ip !== "unknown" ? ip : null;
}

// ── POST /api/news/submit ──────────────────────────────────────────────
//
// Queue a user-pasted news URL for review. Writes ONLY to
// user_news_submissions with status='pending' — never touches
// news_articles and never fetches/scrapes the target synchronously.
// The URL is SSRF-validated (scheme allowlist + private-range DNS
// rejection) so the review tooling can later open it safely.
newsRoute.post(
  "/news/submit",
  zValidator("json", SubmitNewsSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = submitLimiter.check(`news-submit:${ip}`);
    if (!rl.allowed) {
      return c.json(
        { ok: false, error: "rate_limited", retry_after_ms: rl.retryAfterMs },
        429,
      );
    }

    const data = c.req.valid("json");

    // Resolve-then-validate. Submissions are not fetched here, but a URL
    // pointing at localhost/private ranges is either a probe or a mistake —
    // reject it at the door.
    try {
      await assertSafeUrl(data.url);
    } catch (e) {
      const reason = e instanceof BlockedUrlError ? e.message : "ssrf_blocked:invalid";
      return c.json({ ok: false, error: "blocked_url", reason }, 400);
    }

    const sql = getDb();
    const submitterIp = sanitizeIp(ip);

    // Fast duplicate check: an identical pending URL already queued.
    const dup = await sql<any[]>`
      SELECT id FROM user_news_submissions
      WHERE url = ${data.url} AND status = 'pending'
      LIMIT 1
    `;
    if (dup.length > 0) {
      return c.json({
        ok: true,
        id: Number(dup[0].id),
        status: "pending",
        duplicate: true,
        message: "This URL is already in the review queue.",
      });
    }

    let rows: any[];
    try {
      rows = await sql<any[]>`
        INSERT INTO user_news_submissions
          (url, title, note, submitter_ip, session_id)
        VALUES
          (${data.url}, ${data.title ?? null}, ${data.note ?? null},
           ${submitterIp}::inet, ${data.session_id ?? null})
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
    } catch (e: any) {
      return c.json({ ok: false, error: "insert_failed", message: e.message }, 500);
    }

    if (rows.length === 0) {
      // Race: a concurrent submit for the same URL won the partial unique
      // index. Return their id as a duplicate.
      const fb = await sql<any[]>`
        SELECT id FROM user_news_submissions
        WHERE url = ${data.url} AND status = 'pending'
        LIMIT 1
      `;
      return c.json({
        ok: true,
        id: fb.length > 0 ? Number(fb[0].id) : null,
        status: "pending",
        duplicate: true,
        message: "This URL is already in the review queue.",
      });
    }

    return c.json({
      ok: true,
      id: Number(rows[0].id),
      status: "pending",
      duplicate: false,
      message: "Thanks! Your submission is queued for review.",
    });
  },
);

// ── POST /api/news/:id/recommend ───────────────────────────────────────
//
// Lightweight per-article recommendation vote. One vote per (article, IP);
// the denormalized news_articles.recommend_count is maintained with an
// integer increment. All aggregate reads use ::float casts (BigInt rule).
newsRoute.post(
  "/news/:id/recommend",
  zValidator("json", RecommendSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = recommendLimiter.check(`news-rec:${ip}`);
    if (!rl.allowed) {
      return c.json(
        { ok: false, error: "rate_limited", retry_after_ms: rl.retryAfterMs },
        429,
      );
    }

    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) {
      return c.json({ ok: false, error: "bad_id" }, 400);
    }

    const body = c.req.valid("json");
    const sql = getDb();

    // The pins UI shows a UNION of pins and news_articles, so :id may be
    // either. Resolve to a real news_articles id (same pattern as
    // feedback.ts fetchArticleForPin).
    const artRows = await sql<any[]>`
      SELECT id FROM news_articles WHERE id = ${id} LIMIT 1
    `;
    let articleId: number | null = artRows.length > 0 ? Number(artRows[0].id) : null;
    if (articleId === null) {
      const viaPin = await sql<any[]>`
        SELECT a.id AS article_id
        FROM pins p
        LEFT JOIN rss_details r ON r.pin_id = p.id
        LEFT JOIN news_articles a ON a.url = r.source_url
        WHERE p.id = ${id}
        LIMIT 1
      `;
      if (viaPin[0]?.article_id) articleId = Number(viaPin[0].article_id);
    }
    if (articleId === null) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const voterIp = sanitizeIp(ip);
    let counted = false;

    if (voterIp) {
      const ins = await sql<any[]>`
        INSERT INTO news_article_recommendations (article_id, voter_ip, session_id)
        VALUES (${articleId}, ${voterIp}::inet, ${body?.session_id ?? null})
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      counted = ins.length > 0;
    } else {
      // No usable IP (privacy proxy): still record the vote, dedup is
      // impossible — the rate limiter is the abuse bound here.
      await sql`
        INSERT INTO news_article_recommendations (article_id, voter_ip, session_id)
        VALUES (${articleId}, NULL, ${body?.session_id ?? null})
      `;
      counted = true;
    }

    if (counted) {
      await sql`
        UPDATE news_articles
        SET recommend_count = recommend_count + 1
        WHERE id = ${articleId}
      `;
    }

    const [cnt] = await sql<any[]>`
      SELECT recommend_count::float AS n
      FROM news_articles
      WHERE id = ${articleId}
    `;

    return c.json({
      ok: true,
      article_id: articleId,
      counted,
      duplicate: !counted,
      recommend_count: Math.round(Number(cnt?.n ?? 0)),
    });
  },
);

// ── GET /api/news/:id/recommend ────────────────────────────────────────
//
// Read the current recommendation count (for popups rendered later).
newsRoute.get("/news/:id/recommend", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) {
    return c.json({ ok: false, error: "bad_id" }, 400);
  }
  const sql = getDb();
  const rows = await sql<any[]>`
    SELECT COALESCE(recommend_count, 0)::float AS n
    FROM news_articles
    WHERE id = ${id}
    LIMIT 1
  `;
  if (rows.length === 0) return c.json({ ok: false, error: "not_found" }, 404);
  return c.json({ ok: true, article_id: id, recommend_count: Math.round(Number(rows[0].n)) });
});
