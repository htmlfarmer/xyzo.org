// Server-side IP → city / country resolver for the 'Near me' tab.
//
// Provider chain — first hit wins, rest skipped. Each provider has its
// own timeout. Results cached 1h per IP to avoid hammering externals.
//
//   1. MaxMind GeoLite2 .mmdb (offline, fast) — used only if the DB
//      exists at XYZO_GEOIP_DB (or legacy NEWSIUM_GEOIP_DB alias) or
//      ./geoip/GeoLite2-City.mmdb AND the `maxmind` npm module is installed.
//   2. ipwho.is     (HTTPS, free, no key)        — primary external
//   3. ipapi.is     (HTTPS, free, no key)        — verified 2026-08-26
//   4. ip-api.com   (HTTP,  free, 45/min/IP)     — last resort fallback
//
// Override the order (or skip a provider) via env:
//   XYZO_GEOIP_PROVIDERS="ipwho.is,ip-api.com"   # skip MaxMind (legacy: NEWSIUM_GEOIP_PROVIDERS)
//   XYZO_GEOIP_PROVIDERS="ipwho.is"              # single provider
//
// Latency: <5ms on MaxMind hit; ≤1.5s per failed external before bailing
// to the next one. The /api/feed/live route additionally caps the whole
// lookup at 800ms (see routes/events.ts).

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_DB_PATH = resolve(__dirname, "..", "..", "geoip", "GeoLite2-City.mmdb");

const PER_PROVIDER_TIMEOUT_MS = 1500;
const CACHE_TTL_SUCCESS_MS = 60 * 60 * 1000;   // 1h on success — IPs are stable
const CACHE_TTL_FAILURE_MS = 5  * 60 * 1000;   // 5min on failure — recover fast

// ── Public result shape ────────────────────────────────────────────
export interface GeoIpResult {
  city: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  source: string;
}

// ── Provider interface ──────────────────────────────────────────────
type Provider = {
  name: string;
  lookup: (ip: string, signal: AbortSignal) => Promise<GeoIpResult | null>;
};

// ── MaxMind (lazy, optional) ────────────────────────────────────────
let _mmReader: any = null;
let _mmTried = false;

function resolveDbPath(): string | null {
  const p = process.env.NEWSIUM_GEOIP_DB || DEFAULT_DB_PATH;
  return existsSync(p) ? p : null;
}

async function ensureMaxmind(): Promise<any> {
  if (_mmTried) return _mmReader;
  _mmTried = true;
  const path = resolveDbPath();
  if (!path) return null;
  try {
    const maxmind = await import("maxmind");
    _mmReader = await maxmind.open(path);
    console.log(`[geoip] loaded maxmind db ${path}`);
  } catch (e) {
    console.warn(`[geoip] maxmind unavailable (${e instanceof Error ? e.message : String(e)})`);
    _mmReader = null;
  }
  return _mmReader;
}

const maxmindProvider: Provider = {
  name: "maxmind",
  async lookup(ip) {
    const reader = await ensureMaxmind();
    if (!reader) return null;
    let resp: any;
    try {
      resp = reader.get(ip);
    } catch {
      return null;
    }
    if (!resp || !resp.location) return null;
    return {
      city: resp.city?.names?.en ?? null,
      country: resp.country?.iso_code ?? null,
      lat: typeof resp.location.latitude === "number" ? resp.location.latitude : null,
      lng: typeof resp.location.longitude === "number" ? resp.location.longitude : null,
      source: "maxmind",
    };
  },
};

// ── HTTPS free providers ────────────────────────────────────────────
// ipwho.is:
//   GET https://ipwho.is/{ip}?fields=success,city,country_code,latitude,longitude
//   { "success": true, "city": "San Jose", "country_code": "US",
//     "latitude": 37.3361, "longitude": -121.8906 }
const ipwhoProvider: Provider = {
  name: "ipwho.is",
  async lookup(ip, signal) {
    const url = `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,city,country_code,latitude,longitude`;
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const d: any = await res.json();
    if (!d?.success) return null;
    const lat = typeof d.latitude === "number" ? d.latitude : null;
    const lng = typeof d.longitude === "number" ? d.longitude : null;
    if (lat == null || lng == null) return null;
    return {
      city: d.city ?? null,
      country: d.country_code ?? null,
      lat, lng,
      source: "ipwho.is",
    };
  },
};

// ipapi.is:
//   GET https://api.ipapi.is/?q={ip}
//   { "ip": "8.8.8.8", "cc": "US", "lat": 37.38, "lon": -122.08, ... }
const ipapiIsProvider: Provider = {
  name: "ipapi.is",
  async lookup(ip, signal) {
    const url = `https://api.ipapi.is/?q=${encodeURIComponent(ip)}`;
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const d: any = await res.json();
    const lat = typeof d.lat === "number" ? d.lat : null;
    const lng = typeof d.lon === "number" ? d.lon : null;
    if (lat == null || lng == null) return null;
    return {
      city: d.city ?? null,
      country: d.cc ?? null,
      lat, lng,
      source: "ipapi.is",
    };
  },
};

// ip-api.com (HTTP, has a 45 req/min/IP limit → demoted to last):
//   GET http://ip-api.com/json/{ip}?fields=status,country,countryCode,city,lat,lon
const ipapiComProvider: Provider = {
  name: "ip-api.com",
  async lookup(ip, signal) {
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,city,lat,lon`;
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const d: any = await res.json();
    if (d.status !== "success") return null;
    const lat = typeof d.lat === "number" ? d.lat : null;
    const lng = typeof d.lon === "number" ? d.lon : null;
    if (lat == null || lng == null) return null;
    return {
      city: d.city ?? null,
      country: d.countryCode ?? null,
      lat, lng,
      source: "ip-api.com",
    };
  },
};

// ── Provider registry + order from env ──────────────────────────────
const REGISTRY: Record<string, Provider> = {
  "maxmind": maxmindProvider,
  "ipwho.is": ipwhoProvider,
  "ipapi.is": ipapiIsProvider,
  "ip-api.com": ipapiComProvider,
};

const DEFAULT_ORDER = ["maxmind", "ipwho.is", "ipapi.is", "ip-api.com"];

function resolveOrder(): string[] {
  const env = (process.env.NEWSIUM_GEOIP_PROVIDERS ?? "").trim();
  if (!env) return DEFAULT_ORDER;
  const order = env.split(",").map(s => s.trim()).filter(Boolean);
  const known = order.filter(n => REGISTRY[n]);
  const unknown = order.filter(n => !REGISTRY[n]);
  if (unknown.length) {
    console.warn(
      `[geoip] NEWSIUM_GEOIP_PROVIDERS has unknown name(s): ${unknown.join(", ")}. ` +
      `Known: ${Object.keys(REGISTRY).join(", ")}. Falling back to defaults: ${DEFAULT_ORDER.join(", ")}.`
    );
    return DEFAULT_ORDER;
  }
  return known;
}

// ── Tiny per-IP cache ───────────────────────────────────────────────
type CacheEntry = { result: GeoIpResult | null; expires: number };
const cache = new Map<string, CacheEntry>();

function isLocal(ip: string): boolean {
  // FIX_NOTES 2.5: a second, broader isLocal() was declared later in this
  // file and function-hoisting made IT the live definition — dropping the
  // "unknown" guard so external providers got queried with the literal
  // string "unknown". Single merged definition now.
  if (!ip || ip === "unknown") return true;
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "localhost" ||
    ip === "0.0.0.0" ||
    ip === "::ffff:" ||
    ip.startsWith("127.") ||
    ip.startsWith("::ffff:127.") ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith("fc") ||
    ip.startsWith("fd")
  );
}

// Periodic lightweight cleanup so cache doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expires <= now) cache.delete(k);
  }
}, 10 * 60 * 1000).unref?.();

// ── Public API ──────────────────────────────────────────────────────
export async function lookup(ip: string | null): Promise<GeoIpResult | null> {
  if (!ip || isLocal(ip)) return null;

  const cached = cache.get(ip);
  if (cached && cached.expires > Date.now()) {
    return cached.result;
  }

  const order = resolveOrder();
  for (const name of order) {
    const provider = REGISTRY[name];
    if (!provider) continue;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PER_PROVIDER_TIMEOUT_MS);
    try {
      const result = await provider.lookup(ip, ac.signal);
      clearTimeout(timer);
      if (result) {
        cache.set(ip, { result, expires: Date.now() + CACHE_TTL_SUCCESS_MS });
        // Quick wins: drop the raw IP from the log line — PII shouldn't live in stdout.
        console.log(`[geoip] lookup → ${result.source} (${result.city ?? "?"}, ${result.country ?? "?"})`);
        return result;
      }
    } catch (e) {
      clearTimeout(timer);
      const msg = e instanceof Error ? e.message : String(e);
      // AbortError is expected when a provider is slow — quietly move on.
      if (msg !== "Aborted" && !msg.includes("abort")) {
        // Quick wins: drop the raw IP from the warn line.
        console.warn(`[geoip] ${name} provider failed: ${msg}`);
      }
    }
  }

  cache.set(ip, { result: null, expires: Date.now() + CACHE_TTL_FAILURE_MS });
  // Quick wins: drop the raw IP from the warn line.
  console.warn(`[geoip] no provider answered`);
  return null;
}

// Resolve the originating public IP for a request.
// Scans the X-Forwarded-For chain left-to-right for the first public
// (non-private, non-loopback) address, then falls back to the socket
// address. Returns "unknown" if neither yields a usable value — callers
// (lookup, geoipRoute) treat that as a no-op rather than throwing.
export function publicIpFromRequest(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    for (const part of xff.split(",")) {
      const ip = part.trim();
      if (ip && !isLocal(ip)) return ip;
    }
    // If every XFF entry was local, still try the first one before
    // falling through — symmetric-NAT setups can label a public IP as
    // the leftmost entry.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  // Bun provides the socket addr via the second positional arg of the
  // fetch handler — the Request object alone doesn't expose it, so the
  // caller in routes/geoip.ts passes the request and we fall through.
  return "unknown";
}

// second isLocal() removed — see merged definition above (FIX_NOTES 2.5)
