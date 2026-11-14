import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { GeocodeQuerySchema } from "../validate";
import { RateLimiter, getClientIp } from "../ratelimit";

export const geocodeRoute = new Hono();

const submitLimiter = new RateLimiter({ max: 60, windowMs: 60 * 60 * 1000 });

interface GeocodeResult {
  lat: number;
  lng: number;
  display_name: string;
  source: "nominatim" | "ai";
  place_type?: string;
  boundingbox?: [string, string, string, string]; // [south, north, west, east]
}

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "xyzo.org/1.0 (https://xyzo.org; contact@xyzo.org)";

// In-memory LRU-ish cache so repeat queries (and the per-keystroke debounced
// search) don't hammer Nominatim. Cache key = lowercased trimmed query.
const GEO_CACHE_MAX = 500;
const geoCache = new Map<string, { value: GeocodeResult | null; expires: number }>();
const GEO_TTL_MS = 6 * 60 * 60 * 1000; // 6 h — Nominatim data is fairly stable
function geoCacheGet(q: string): GeocodeResult | null | undefined {
  const key = q.trim().toLowerCase();
  const e = geoCache.get(key);
  if (!e) return undefined;
  if (e.expires < Date.now()) { geoCache.delete(key); return undefined; }
  return e.value;
}
function geoCacheSet(q: string, value: GeocodeResult | null) {
  const key = q.trim().toLowerCase();
  if (geoCache.size >= GEO_CACHE_MAX) {
    // simple eviction: drop the oldest insertion
    const first = geoCache.keys().next().value;
    if (first !== undefined) geoCache.delete(first);
  }
  geoCache.set(key, { value, expires: Date.now() + GEO_TTL_MS });
}

// Server-side Nominatim throttle. Nominatim's usage policy allows at most
// 1 request per second to their shared service. We serialize all our
// requests and enforce ≥1.1s between them, and bump to AI fallback after a
// 429 instead of hammering them again.
let lastNominatimAt = 0;
const NOMINATIM_MIN_GAP_MS = 1100;
let nominatimRecentlyLimited = 0; // ms timestamp; if recent, skip Nominatim
const NOMINATIM_BACKOFF_MS = 5 * 60 * 1000;

async function nominatimLookup(q: string): Promise<GeocodeResult | null> {
  if (Date.now() < nominatimRecentlyLimited) {
    return null;
  }
  const now = Date.now();
  const wait = lastNominatimAt + NOMINATIM_MIN_GAP_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatimAt = Date.now();
  const url = `${NOMINATIM}?format=json&limit=1&q=${encodeURIComponent(q)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
    });
  } catch (e) {
    console.warn("[geocode] nominatim network error:", (e as Error).message);
    return null;
  }
  if (res.status === 429 || res.status === 403) {
    nominatimRecentlyLimited = Date.now() + NOMINATIM_BACKOFF_MS;
    console.warn(`[geocode] nominatim ${res.status} — backing off ${NOMINATIM_BACKOFF_MS / 1000}s, will fall through to AI`);
    return null;
  }
  if (!res.ok) {
    console.warn("[geocode] nominatim HTTP", res.status);
    return null;
  }
  const rows = (await res.json()) as Array<{ lat: string; lon: string; display_name: string; type?: string; boundingbox?: string[] }>;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const lat = Number(rows[0].lat);
  const lng = Number(rows[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const result: GeocodeResult = {
    lat,
    lng,
    display_name: rows[0].display_name,
    source: "nominatim",
  };
  if (rows[0].type) result.place_type = rows[0].type;
  if (rows[0].boundingbox && rows[0].boundingbox.length === 4) {
    result.boundingbox = rows[0].boundingbox as [string, string, string, string];
  }
  return result;
}

function extractJsonCoords(text: string): { lat: number; lng: number } | null {
  // Find the first {...} block in the model output and try to parse it.
  const matches = [...text.matchAll(/\{[^{}]*\}/g)];
  for (const m of matches) {
    try {
      const obj = JSON.parse(m[0]);
      const lat = obj.lat ?? obj.latitude;
      const lng = obj.lng ?? obj.lon ?? obj.longitude;
      if (typeof lat === "number" && typeof lng === "number"
          && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        return { lat, lng };
      }
    } catch { /* keep scanning */ }
  }
  return null;
}

async function aiLookup(q: string): Promise<GeocodeResult | null> {
  const endpoint = process.env.NEWSIUM_AI_URL ?? "http://192.168.1.3:8888/chat/stream";
  const prompt =
    `Reply with ONLY a JSON object, no other text, no markdown: ` +
    `{"lat": <number>, "lng": <number>}. ` +
    `Location: ${q}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25_000);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-MCP-Safe": "true" },
      body: JSON.stringify({ message: prompt, stream: true }),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      console.warn("[geocode] ai HTTP", res.status);
      return null;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
    let done = false;
    while (!done) {
      const { value, done: rd } = await reader.read();
      done = rd;
      if (value) {
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") { done = true; break; }
          try {
            const obj = JSON.parse(payload);
            const delta = obj?.choices?.[0]?.delta?.content;
            if (typeof delta === "string") full += delta;
          } catch { /* skip malformed line */ }
        }
      }
    }
    const coords = extractJsonCoords(full);
    if (!coords) {
      console.warn("[geocode] ai no coords in:", full.slice(0, 200));
      return null;
    }
    return { ...coords, display_name: q, source: "ai" };
  } catch (e) {
    console.warn("[geocode] ai error:", (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

geocodeRoute.get("/geocode", zValidator("query", GeocodeQuerySchema), async (c) => {
  const { q } = c.req.valid("query");
  if (!q) return c.json({ error: "empty_query" }, 400);

  const cached = geoCacheGet(q);
  if (cached !== undefined) {
    if (cached === null) return c.json({ error: "not_found" }, 404);
    c.header("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    return c.json(cached);
  }

  const ip = getClientIp(c.req.raw);
  const limit = submitLimiter.check(ip);
  if (!limit.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: limit.retryAfterMs }, 429);
  }

  const nomi = await nominatimLookup(q);
  if (nomi) {
    geoCacheSet(q, nomi);
    c.header("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    return c.json(nomi);
  }

  const ai = await aiLookup(q);
  if (ai) {
    geoCacheSet(q, ai);
    c.header("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    return c.json(ai);
  }

  geoCacheSet(q, null);
  return c.json({ error: "not_found" }, 404);
});
