// /api/image-proxy — stream-only image proxy for CORP/referrer-blocked images.
//
// When a publisher's image has Cross-Origin-Resource-Policy: same-origin or
// checks the Referer header, the browser blocks the <img> load. The frontend
// falls back to this endpoint which fetches the image server-side and streams
// it back with permissive headers. No images are stored on disk — this is a
// pure pass-through with a short-lived in-memory cache.
//
// Performance (2026-09-30):
//   - Negative cache: failed URLs are remembered for 30 min so dead images
//     don't re-pay the SSRF/DNS/redirect cost on every attempt.
//   - Host circuit breaker: after 5 consecutive failures from one host,
//     all requests to that host short-circuit for 10 min.
//   - Timeout reduced 10s → 5s (dead hosts shouldn't hold connections).

import { Hono } from "hono";
import { safeFetch, BlockedUrlError } from "../lib/ssrf";

export const imageProxyRoute = new Hono();

// ── In-memory positive cache (successful images) ─────────────────────
interface CacheEntry {
  body: ArrayBuffer;
  contentType: string;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 200;

function getCached(url: string): CacheEntry | null {
  const entry = cache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    cache.delete(url);
    return null;
  }
  return entry;
}

function setCache(url: string, body: ArrayBuffer, contentType: string) {
  if (cache.size >= MAX_CACHE_SIZE) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, v] of cache) {
      if (v.cachedAt < oldestTime) {
        oldestTime = v.cachedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(url, { body, contentType, cachedAt: Date.now() });
}

// ── Negative cache (failed URLs — don't retry) ────────────────────────
// TWO lifetimes, because "failed once" means two very different things:
//   · a photo that answered 404 is gone and will still be gone → 30 min
//   · a timeout, a 503 or a publisher's 403 is a BLIP → retry in a minute
// Caching a blip for 30 minutes keeps a perfectly healthy image broken
// for half an hour: measured 2026-10-30, two romaniatv.net photos were
// 404ing from this cache while their origin answered 200 in 1.6 s.
const negativeCache = new Map<string, { status: number; at: number; transient: boolean }>();

// ── the PLACEHOLDER ─────────────────────────────────────────────────────
//
// A dead picture must not make a NOISE.
//
// The proxy is used as an <img src>, so every failure it reports is a
// console error in the reader's browser: the network layer logs it and
// no JavaScript can suppress it. Two publishers alone account for
// thousands of dead links (a hotlink-protected Indonesian paper, and a
// Brazilian site whose /dependent/ image paths 404), so the console
// filled with red lines that said nothing useful — the picture is
// gone at the publisher, and the site is fine.
//
// So a failed image returns HTTP 200 with a 1x1 TRANSPARENT PNG: the
// browser loads it happily, the <img> paints nothing, and the console
// stays clean. The client hides a placeholder-sized image on load (the
// app checks naturalWidth), so the layout is exactly as it was when
// the image used to fail.
//
// The 400 (a malformed request) stays an error: that one is about the
// REQUEST, and the caller needs to see it.
//
// The 429 used to stay an error too, on the same reasoning — but the
// rate limit is PER IP, and an IP is not a person (a mobile carrier's
// CGNAT puts thousands of readers behind one address). So a 429 on an
// <img> was a console error a reader could neither silence nor act
// on: they had not asked for too much, they were behind a shared
// address. It is the PLACEHOLDER now, with `Retry-After` still saying
// what happened.
const PLACEHOLDER_PNG = Buffer.from(
  // A 1x1 transparent PNG.
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function placeholder() {
  return new Response(PLACEHOLDER_PNG, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      // Short, so a publisher who FIXES the picture gets it back
      // without the reader clearing anything.
      "Cache-Control": "public, max-age=300",
      "Cross-Origin-Resource-Policy": "cross-origin",
      // The client can see this header on a fetch(), and it tells the
      // story: this is a placeholder, not the picture.
      "X-Proxy-Placeholder": "1",
    },
  });
}
const NEG_TTL_MS = 30 * 60 * 1000; // a genuinely gone resource
const NEG_TTL_TRANSIENT_MS = 60 * 1000; // a blip — retry in a minute
const MAX_NEG_SIZE = 500;

// 404/410/400 mean the resource itself is not there. Everything else —
// a publisher's 403, a 429 rate limit, any 5xx — is the host having a
// moment, and deserves a short retry rather than a half-hour ban.
function isTransientUpstream(status: number): boolean {
  return status >= 500 || status === 403 || status === 429;
}

function getNegCached(url: string): number | null {
  const entry = negativeCache.get(url);
  if (!entry) return null;
  const ttl = entry.transient ? NEG_TTL_TRANSIENT_MS : NEG_TTL_MS;
  if (Date.now() - entry.at > ttl) {
    negativeCache.delete(url);
    return null;
  }
  return entry.status;
}

function setNegCached(url: string, status: number, transient = false) {
  if (negativeCache.size >= MAX_NEG_SIZE) {
    // Evict oldest
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, v] of negativeCache) {
      if (v.at < oldestTime) {
        oldestTime = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey) negativeCache.delete(oldestKey);
  }
  negativeCache.set(url, { status, at: Date.now(), transient });
}

// ── Host circuit breaker ─────────────────────────────────────────────
// After N consecutive failures from a host, short-circuit all requests
// to that host for a cooldown period.
const hostFailures = new Map<string, { count: number; lastFail: number; openUntil: number }>();
const HOST_FAIL_THRESHOLD = 5;
const HOST_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

function isHostOpen(host: string): boolean {
  const entry = hostFailures.get(host);
  if (!entry) return true;
  if (Date.now() < entry.openUntil) return false;
  // Cooldown expired — reset
  hostFailures.delete(host);
  return true;
}

function recordHostFailure(host: string) {
  const entry = hostFailures.get(host) || { count: 0, lastFail: 0, openUntil: 0 };
  entry.count += 1;
  entry.lastFail = Date.now();
  if (entry.count >= HOST_FAIL_THRESHOLD) {
    entry.openUntil = Date.now() + HOST_COOLDOWN_MS;
  }
  hostFailures.set(host, entry);
}

function recordHostSuccess(host: string) {
  hostFailures.delete(host);
}

// ── Rate limiting (per IP, simple sliding window) ─────────────────────
const rateBuckets = new Map<string, number[]>();
// 300, not 60.
//
// The limit is PER IP, and an IP is not a person: a mobile carrier's
// CGNAT puts thousands of readers behind ONE address, and an office
// NAT does the same. At 60/minute a shared address was a shared
// failure — one reader's burst of images (a page load asks for ~15)
// starved every other reader behind that address, and every image
// they then lost was a CONSOLE ERROR.
//
// The real cost is the upstream fetch, and the negative cache means a
// URL that failed is not re-fetched for 30 minutes — so the limit is
// about stopping the endpoint being used as an open relay, not about
// protecting a scarce resource. 300/minute still does that.
const RATE_LIMIT = 300;
const RATE_WINDOW_MS = 60 * 1000; // 1 minute

function checkRate(ip: string): boolean {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket) {
    bucket = [];
    rateBuckets.set(ip, bucket);
  }
  const cutoff = now - RATE_WINDOW_MS;
  while (bucket.length > 0 && bucket[0] < cutoff) bucket.shift();
  if (bucket.length >= RATE_LIMIT) return false;
  bucket.push(now);
  return true;
}

// ── URL validation ────────────────────────────────────────────────────
const BLOCKED_HOSTS = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "::1",
  "metadata.google.internal", "169.254.169.254",
]);

function isValidImageUrl(raw: string): { ok: true; url: string; host: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "Only http/https allowed" };
  }
  if (BLOCKED_HOSTS.has(parsed.hostname)) {
    return { ok: false, reason: "Blocked host" };
  }
  const host = parsed.hostname;
  if (/^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^192\.168\./.test(host)) {
    return { ok: false, reason: "Private IP blocked" };
  }
  return { ok: true, url: parsed.href, host };
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const FETCH_TIMEOUT_MS = 5_000; // 5s (was 10s — dead hosts shouldn't hold connections)

// ── Endpoint ──────────────────────────────────────────────────────────
imageProxyRoute.get("/image-proxy", async (c) => {
  const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";

  if (!checkRate(ip)) {
    // TWO ANSWERS, because there are two kinds of caller.
    //
    // The BROWSER asked for an image: an <img> whose src 429s is a
    // console error the reader can neither silence nor act on — they
    // did not ask for too much, they are behind a shared address (a
    // mobile carrier's CGNAT puts thousands of readers behind one
    // address, so one reader's burst of ~15 images a page load
    // starved everyone else behind it). It gets the PLACEHOLDER, with
    // `Retry-After` and `X-Proxy-Rate-Limited` still saying what
    // happened.
    //
    // A caller that explicitly asked for JSON gets the 429 — it can
    // actually back off.
    // The JSON 429 is for a caller that explicitly asked for JSON.
    // Everything else — a browser <img>, or anything that did not say
    // what it wanted — gets the placeholder: this endpoint exists to
    // serve IMAGES, so an image-shaped answer is the right default.
    const accept = (c.req.header("accept") || "").toLowerCase();
    const wantsJson = accept.includes("application/json");
    if (!wantsJson) {
      return new Response(PLACEHOLDER_PNG, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "no-store",
          "Cross-Origin-Resource-Policy": "cross-origin",
          "Retry-After": "60",
          "X-Proxy-Rate-Limited": "1",
        },
      });
    }
    return c.json({ error: "rate_limited" }, 429);
  }

  const rawUrl = c.req.query("url");
  if (!rawUrl) {
    return c.json({ error: "missing_url" }, 400);
  }

  const validation = isValidImageUrl(rawUrl);
  if (!validation.ok) {
    return c.json({ error: validation.reason }, 400);
  }
  const targetUrl = validation.url;
  const host = validation.host;

  // Check positive cache first
  const cached = getCached(targetUrl);
  if (cached) {
    return new Response(cached.body, {
      headers: {
        "Content-Type": cached.contentType,
        "Cache-Control": "public, max-age=300",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "X-Proxy-Cache": "HIT",
      },
    });
  }

  // Check negative cache — don't retry known-failed URLs
  const negStatus = getNegCached(targetUrl);
  if (negStatus !== null) {
    // Every cached UPSTREAM failure answers the PLACEHOLDER.
    //
    // The reasoning (which used to be written down wrongly here): a
    // failure status on an <img> is a console error the reader can
    // neither silence nor act on — the picture is gone at the
    // publisher and the site is fine. So the proxy answers 200 with a
    // 1x1 transparent PNG and the console stays clean.
    //
    // The ONE exception is a cached 400: that is about the REQUEST
    // (a blocked or malformed URL), not about a missing picture, and
    // the caller needs to see it.
    const status = negStatus >= 500 ? 404 : negStatus;
    // A 404 for an <img> is a console error, and a dead picture is
    // not a thing the reader can act on. Hand back the placeholder.
    if (status === 404) return placeholder();
    // A cached 400 is about the REQUEST (a blocked or malformed URL),
    // and the caller needs to see it.
    if (negStatus === 400) {
      return c.json({ error: "url_blocked" }, 400);
    }
    // Anything else the upstream answered (a 403, a 429, a 413) is
    // still a dead <img>: the picture is gone AT THE PUBLISHER.
    return placeholder();
  }

  // Check host circuit breaker — the host has failed repeatedly; its
  // images are unavailable right now, not broken on our side.
  if (!isHostOpen(host)) {
    return placeholder();
  }

  // Fetch the image with browser-like headers to avoid publisher blocks
  try {
    const origin = new URL(targetUrl).origin;
    const { res: resp } = await safeFetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": origin + "/",
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      // Upstream 4xx and 5xx both mean the same thing to an <img>:
      // this picture is not available. 404 says so honestly without
      // making the site look like it is failing. Only the resource being
      // genuinely absent is cached long — a 403/429/5xx is retried in a
      // minute (see NEG_TTL_TRANSIENT_MS).
      setNegCached(targetUrl, 404, isTransientUpstream(resp.status));
      if (resp.status >= 500) recordHostFailure(host);
      return placeholder();
    }

    let contentType = resp.headers.get("content-type") || "application/octet-stream";
    const GENERIC_TYPES = new Set(["application/octet-stream", "binary/octet-stream", "application/binary"]);
    const extMatch = new URL(targetUrl).pathname.match(/\.(jpe?g|png|gif|webp|avif|svg|bmp|ico)$/i);
    const EXT_MIME: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
      webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
    };
    const looksLikeImage = contentType.startsWith("image/") ||
      (GENERIC_TYPES.has(contentType) && !!extMatch);
    if (!looksLikeImage) {
      setNegCached(targetUrl, 415);
      recordHostFailure(host);
      // 415 says "that is not an image", which is a different (and
      // rarer) fault than "the picture is gone" — but it is still a
      // dead <img> and still a console error. Placeholder.
      return placeholder();
    }
    // Upstream said octet-stream but URL is clearly an image — normalize
    if (GENERIC_TYPES.has(contentType) && extMatch) {
      contentType = EXT_MIME[extMatch[1].toLowerCase()] || "image/jpeg";
    }

    const reader = resp.body?.getReader();
    if (!reader) {
      setNegCached(targetUrl, 404);
      recordHostFailure(host);
      return placeholder();
    }

    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > MAX_IMAGE_BYTES) {
        reader.cancel();
        setNegCached(targetUrl, 413);
        // A 413 is still a dead <img> and still a console error — the
        // same reasoning as the 415 above.
        return placeholder();
      }
      chunks.push(value);
    }

    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const buffer = combined.buffer;
    setCache(targetUrl, buffer, contentType);
    recordHostSuccess(host);

    return new Response(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=300",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "X-Proxy-Cache": "MISS",
      },
    });
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      // A host that no longer resolves (dead publisher, expired domain)
      // is a MISSING image — the picture is gone AT THE PUBLISHER, and
      // the reader can neither fix it nor act on it.
      //
      // It used to answer 404 here, with a comment claiming that "404
      // keeps the browser console quiet". That is BACKWARDS: a 404 on
      // an <img> is EXACTLY the console noise this endpoint exists to
      // remove — the browser logs every failed subresource, and no
      // JavaScript can suppress it. A dead publisher's dead domain was
      // therefore still filling the reader's console with red lines.
      //
      // So it is the PLACEHOLDER, like every other dead picture.
      //
      // A genuinely malformed/blocked URL (a private address, a
      // redirect into one) stays 400 — that is about the REQUEST.
      const reason = String(err.message || "").replace(/^ssrf_blocked:/, "");
      const gone = reason === "no_dns_answer" || reason === "dns_fail";
      if (!gone) {
        setNegCached(targetUrl, 400);
        return c.json({ error: "url_blocked" }, 400);
      }
      setNegCached(targetUrl, 404);
      return placeholder();
    }
    // Network error / timeout — the external image could not be
    // fetched, which is "not available" from here. Our server did not
    // fail; a remote image did. Transient: a 5 s timeout says nothing
    // about whether the photo exists, so it is retried in a minute
    // instead of being banned for half an hour.
    //
    // And it is the PLACEHOLDER, not a 404: a 404 on an <img> is the
    // console noise this endpoint exists to remove.
    setNegCached(targetUrl, 404, true);
    recordHostFailure(host);
    return placeholder();
  }
});
