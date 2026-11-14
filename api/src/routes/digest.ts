import { Hono } from "hono";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Daily digest — the editorial layer behind the daily news video.
 *
 * worker/daily_digest.py picks the day's most *interesting* stories (not
 * simply the loudest ones) and writes a JSON artifact. This route serves
 * that artifact so the site, the video renderer and the uploader all read
 * the same reviewable draft.
 *
 * Endpoints:
 *   GET /api/digest/today    — the current digest
 *   GET /api/digest/status   — freshness + counts (for the debug panel)
 *
 * The artifact is a file, not a table: it is written once a day, reviewed
 * by a human, and published. A database table would add a write path for
 * no benefit.
 */

export const digestRoute = new Hono();

const DIGEST_PATH =
  process.env.XYZO_DIGEST_PATH ||
  join("/var/www/vhosts/xyzo.org", "data", "daily_digest.json");

interface DigestStory {
  rank: number;
  event_id: number;
  headline: string;
  headline_en?: string;
  why?: string;
  narration?: string;
  interest?: number;
  international?: string;
  category?: string;
  event_type?: string;
  place?: string | null;
  country?: string | null;
  lat?: number | null;
  lng?: number | null;
  score?: number;
  signals?: Record<string, number>;
  hours_old?: number;
  outlets?: number;
  countries?: number;
  articles?: number;
  linked_events?: number;
  outlet_names?: string[];
  sources?: Array<{
    title: string;
    url: string;
    source: string;
    country: string;
    published_at: string | null;
  }>;
}

interface Digest {
  version: number;
  generated_at: string;
  window_hours: number;
  story_count: number;
  stories: DigestStory[];
}

let cache: { digest: Digest | null; mtimeMs: number; loadedAt: number } = {
  digest: null,
  mtimeMs: 0,
  loadedAt: 0,
};

// Re-read the file at most every 30s — it changes once a day, but the
// dashboard may poll it.
const CACHE_TTL_MS = 30_000;

async function loadDigest(): Promise<Digest | null> {
  const now = Date.now();
  if (cache.digest && now - cache.loadedAt < CACHE_TTL_MS) return cache.digest;
  try {
    const st = await stat(DIGEST_PATH);
    if (cache.digest && st.mtimeMs === cache.mtimeMs) {
      cache.loadedAt = now;
      return cache.digest;
    }
    const raw = await readFile(DIGEST_PATH, "utf8");
    const parsed = JSON.parse(raw) as Digest;
    cache = { digest: parsed, mtimeMs: st.mtimeMs, loadedAt: now };
    return parsed;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") {
      console.warn("[digest] failed to read digest:", e.message);
    }
    cache.loadedAt = now;
    return null;
  }
}

digestRoute.get("/digest/today", async (c) => {
  const digest = await loadDigest();
  if (!digest) {
    return c.json({
      ok: true,
      available: false,
      message: "No digest yet — worker/daily_digest.py has not run.",
      stories: [],
      count: 0,
    });
  }
  return c.json({
    ok: true,
    available: true,
    generated_at: digest.generated_at,
    window_hours: digest.window_hours,
    stories: digest.stories,
    count: digest.stories.length,
  });
});

digestRoute.get("/digest/status", async (c) => {
  const digest = await loadDigest();
  const ageMs = digest ? Date.now() - Date.parse(digest.generated_at) : null;
  return c.json({
    ok: true,
    available: !!digest,
    generated_at: digest?.generated_at ?? null,
    age_hours: ageMs == null ? null : Math.round((ageMs / 3_600_000) * 10) / 10,
    story_count: digest?.story_count ?? 0,
    path: DIGEST_PATH,
  });
});
