import { Hono } from "hono";
import { lookup, publicIpFromRequest } from "../geoip";

export const geoipRoute = new Hono();

// ── GET /api/geoip ───────────────────────────────────────────────────
// Server-side IP → city/country resolution. Used by the frontend's
// "Near me" tab as a fallback when browser geolocation is unavailable.
// Uses the shared publicIpFromRequest (XFF chain scan) + provider chain
// (MaxMind → ipwho.is → ipapi.is → ip-api.com). The `ip` field (masked
// to /24) is debug info about which address actually resolved.
geoipRoute.get("/geoip", async (c) => {
  const ip = publicIpFromRequest(c.req.raw);
  const result = await lookup(ip);
  return c.json({ location: result, ip: maskIp(ip) });
});

// Blur the last octet(s) so the response never leaks a full visitor IP.
function maskIp(ip: string): string {
  if (ip === "unknown" || !/\d/.test(ip)) return ip;
  if (ip.includes(":")) return ip.split(":").slice(0, 4).join(":") + "::/64";
  return ip.split(".").slice(0, 3).join(".") + ".0";
}
