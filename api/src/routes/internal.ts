// Internal endpoints — called by the Python worker after a successful
// INSERT into news_articles. NOT exposed to the public internet; we
// gate on a shared secret (XYZO_INTERNAL_KEY) that the worker also
// reads from its environment.
//
// Why HTTP and not Postgres LISTEN/NOTIFY:
//   - LISTEN/NOTIFY would require the worker to send a NOTIFY on every
//     insert AND the API to maintain a LISTEN subscription on every
//     instance. That's fine for multi-instance, but xyzo.org runs a
//     single API instance on Bun, so the simpler in-process pub/sub
//     (feed-broadcaster.ts) covers the same ground with one round-trip.
//   - If xyzo.org ever scales to multiple API instances, swap this
//     whole module for a LISTEN/NOTIFY subscriber (see
//     api/src/queue/listenClientPool.ts for the pattern).

import { Hono } from "hono";
import { z } from "zod";
import { broadcastNewArticle } from "../feed-broadcaster";

export const internalRoute = new Hono();

// Auth: simple shared-secret header. Constant-time compare prevents
// timing oracles; if the env var is unset, the endpoint refuses
// everything (fail-closed).
function internalAuth(req: Request): boolean {
  const expected = process.env.XYZO_INTERNAL_KEY;
  if (!expected) return false;
  const got = req.headers.get("x-internal-key");
  if (!got || got.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < got.length; i++) {
    mismatch |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

const ArticleCreatedSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1).max(500),
  url: z.string().url().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  summary: z.string().optional(),
  source_id: z.number().int().optional(),
  status: z.string().optional(),
  published_at: z.string().optional(),
  image_url: z.string().max(2000).nullable().optional(),
});

// ── POST /api/internal/article-created ───────────────────────────────
//
// Worker calls this after a successful INSERT into news_articles.
// The article is fanned out to every SSE subscriber of /feed/live/stream.
internalRoute.post("/article-created", async (c) => {
  if (!internalAuth(c.req.raw)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = ArticleCreatedSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_failed", details: parsed.error.issues }, 400);
  }

  // Fire-and-forget the broadcast — clients don't need to know if it
  // landed. Awaiting it would slow the worker for no benefit.
  void broadcastNewArticle(parsed.data).catch((e) => {
    console.error("[internal] broadcast failed:", e);
  });

  return c.json({ ok: true });
});
