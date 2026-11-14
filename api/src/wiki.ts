// Wikipedia geosearch proxy. Calls Wikipedia's public API on demand and
// caches results for 1h per (lat, lng, radius) tuple. No DB needed — the
// full Wikipedia article corpus lives on en.wikipedia.org's CDN and is
// free for low-volume use (they ask for a User-Agent and rate-limit
// generous clients at 200 req/s; we're nowhere near that).
//
// Returns: title, lat, lng, distance_m, pageid, and a short extract
// (the first sentence of the Wikipedia intro) when available.

interface WikiCacheEntry {
  fetchedAt: number;
  results: WikiArticle[];
}

const WIKI_TTL_MS = 60 * 60 * 1000;       // 1 hour
const WIKI_CACHE_MAX = 256;               // cap memory

const wikiCache = new Map<string, WikiCacheEntry>();
const wikiInflight = new Map<string, Promise<WikiArticle[]>>();

export interface WikiArticle {
  pageid: number;
  title: string;
  lat: number;
  lng: number;
  distance_m: number;
  url: string;
  extract?: string;
  thumbnail?: { source: string; width: number; height: number } | null;
}

export interface WikiQuery {
  lat: number;
  lng: number;
  radius_m?: number;   // default 5000m, max 50000m
  limit?: number;      // default 25, max 200
  lang?: string;       // default "en"
}

function cacheKey(q: WikiQuery): string {
  return `${q.lang || "en"}|${q.lat.toFixed(4)},${q.lng.toFixed(4)}|${q.radius_m ?? 5000}|${q.limit ?? 25}`;
}

async function fetchSinglePointHits(lang: string, lat: number, lng: number, radiusM: number, limit: number): Promise<any[]> {
  const radius = Math.min(Math.max(radiusM, 10), 10_000);
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  url.searchParams.set("action", "query");
  url.searchParams.set("list", "geosearch");
  url.searchParams.set("gscoord", `${lat}|${lng}`);
  url.searchParams.set("gsradius", String(radius));
  url.searchParams.set("gslimit", String(limit));
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");

  try {
    const geoRes = await fetch(url, {
      headers: {
        "User-Agent": "xyzo.org/1.0 (https://xyzo.org/contact) bun-runtime",
        "Api-User-Agent": "xyzo.org/1.0 (https://xyzo.org/contact)",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!geoRes.ok) return [];
    const geoData: any = await geoRes.json();
    return geoData?.query?.geosearch || [];
  } catch (e) {
    return [];
  }
}

async function fetchFromWikipedia(q: WikiQuery): Promise<WikiArticle[]> {
  const lang = q.lang || "en";
  const reqRadius = Math.min(Math.max(q.radius_m ?? 5000, 100), 50_000);
  const limit = Math.min(Math.max(q.limit ?? 25, 1), 200);

  let hits: any[] = [];
  if (reqRadius <= 10_000) {
    hits = await fetchSinglePointHits(lang, q.lat, q.lng, reqRadius, limit);
  } else {
    // Multi-point grid sampling for radii > 10km (Wikipedia API caps gsradius at 10,000m)
    const step = (reqRadius / 1000) * 0.007; // ~0.07 deg per 10km
    const coords = [
      { lat: q.lat, lng: q.lng },
      { lat: Math.min(85, q.lat + step), lng: q.lng },
      { lat: Math.max(-85, q.lat - step), lng: q.lng },
      { lat: q.lat, lng: ((q.lng + step + 180) % 360) - 180 },
      { lat: q.lat, lng: ((q.lng - step + 180) % 360) - 180 },
    ];
    const pointHitsList = await Promise.all(
      coords.map((c) => fetchSinglePointHits(lang, c.lat, c.lng, 10_000, Math.min(limit, 30)))
    );
    const seenIds = new Set<number>();
    for (const pointHits of pointHitsList) {
      for (const h of pointHits) {
        if (!seenIds.has(h.pageid)) {
          seenIds.add(h.pageid);
          hits.push(h);
        }
      }
    }
    hits = hits.slice(0, limit);
  }

  if (hits.length === 0) return [];

  // Second call: extract the lead sentence + thumbnail for each title.
  const extUrl = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  extUrl.searchParams.set("action", "query");
  extUrl.searchParams.set("prop", "extracts|pageimages");
  extUrl.searchParams.set("exintro", "1");
  extUrl.searchParams.set("explaintext", "1");
  extUrl.searchParams.set("exsentences", "1");
  extUrl.searchParams.set("piprop", "thumbnail");
  extUrl.searchParams.set("pithumbsize", "120");
  extUrl.searchParams.set("redirects", "1");
  extUrl.searchParams.set("format", "json");
  extUrl.searchParams.set("origin", "*");
  extUrl.searchParams.set("titles", hits.map((h) => h.title).join("|"));

  const extRes = await fetch(extUrl, {
    headers: { "User-Agent": "xyzo.org/1.0 (https://xyzo.org/contact) bun-runtime" },
    signal: AbortSignal.timeout(8000),
  });
  let extData: any = { query: { pages: {} } };
  if (extRes.ok) {
    try { extData = await extRes.json(); } catch { /* upstream returned non-JSON */ }
  }
  const pages: Record<string, any> = extData?.query?.pages || {};
  const extractByTitle: Record<string, { extract?: string; thumbnail?: any }> = {};
  for (const page of Object.values(pages)) {
    if (!page || !page.title) continue;
    extractByTitle[page.title] = {
      extract: page.extract || undefined,
      thumbnail: page.thumbnail || null,
    };
  }

  return hits.map((h) => {
    const enriched = extractByTitle[h.title] || {};
    return {
      pageid: h.pageid,
      title: h.title,
      lat: Number(h.lat),
      lng: Number(h.lon),
      distance_m: Number(h.dist) || 0,
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(h.title).replace(/ /g, "_"))}`,
      extract: enriched.extract,
      thumbnail: enriched.thumbnail
        ? { source: enriched.thumbnail.source, width: enriched.thumbnail.width, height: enriched.thumbnail.height }
        : null,
    };
  });
}

export async function wikiNear(q: WikiQuery): Promise<WikiArticle[]> {
  const key = cacheKey(q);
  const cached = wikiCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < WIKI_TTL_MS) {
    return cached.results;
  }
  // Dedupe concurrent fetches for the same key.
  const existing = wikiInflight.get(key);
  if (existing) return existing;

  const promise = fetchFromWikipedia(q)
    .then((results) => {
      wikiCache.set(key, { fetchedAt: Date.now(), results });
      // Cap memory.
      if (wikiCache.size > WIKI_CACHE_MAX) {
        const firstKey = wikiCache.keys().next().value;
        if (firstKey) wikiCache.delete(firstKey);
      }
      return results;
    })
    .catch((e) => {
      // Surface to caller; clear the inflight slot so a retry can happen.
      throw e;
    })
    .finally(() => {
      wikiInflight.delete(key);
    });
  wikiInflight.set(key, promise);
  return promise;
}
