// Server-side request forgery (SSRF) guard for user-supplied URLs.
//
// Problem: endpoints like /api/sniff and /api/image-proxy fetch
// attacker-chosen URLs from the server, which sits inside a network with
// a Postgres, a Bun API, an AI box (192.168.1.3) and cloud metadata
// services. Text blocklists are bypassable (decimal IPs, 127.0.0.2,
// bracketed ::1, nip.io DNS rebinding, redirect hops).
//
// Defense: resolve-then-validate — resolve the hostname to concrete IPs,
// reject if ANY answer is non-public, fetch WITHOUT following redirects,
// and re-validate every hop manually. This shrinks (but cannot fully
// eliminate, absent a proxy) the rebinding window to the
// resolve→connect gap; short TTLs on the attacker DNS make even that
// unlikely.
import { promises as dns } from "node:dns";

export class BlockedUrlError extends Error {
  constructor(reason: string) {
    super(`ssrf_blocked:${reason}`);
    this.name = "BlockedUrlError";
  }
}

function ipv4ToBytes(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (bytes.some((b) => Number.isNaN(b) || b < 0 || b > 255)) return null;
  return bytes;
}

export function isPrivateAddress(ip: string): boolean {
  let s = ip.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s.startsWith("::ffff:")) s = s.slice(7); // IPv4-mapped IPv6

  const v4 = ipv4ToBytes(s);
  if (v4) {
    const [a, b] = v4;
    if (a === 0 || a === 10 || a === 127) return true; // this-host/private/loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  // IPv6
  if (s.includes(":")) {
    if (s === "::" || s === "::1") return true;
    if (/^fe[89ab]/.test(s)) return true; // link-local
    if (/^f[cd]/.test(s)) return true; // ULA
    if (/^2001:db8/i.test(s)) return true; // doc (harmless but never public)
    return false;
  }
  // Not parseable as an IP literal — treat as unsafe.
  return true;
}

export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError("malformed_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError("scheme");
  }
  let host = url.hostname;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

  // A host that is all digits/dots must be a valid dotted quad — reject
  // obfuscated decimal/hex/octal single-label forms (2130706433 etc.).
  if (/^[\d.]+$/.test(host) && !ipv4ToBytes(host)) {
    throw new BlockedUrlError("numeric_host");
  }

  let ips: string[] = [];
  const isIpLiteral = !!ipv4ToBytes(host) || host.includes(":");
  if (isIpLiteral) {
    ips = [host];
  } else {
    if (/^localhost$/i.test(host) || host.endsWith(".local") || host.endsWith(".internal")) {
      throw new BlockedUrlError("local_name");
    }
    try {
      const [a4, a6] = await Promise.all([
        dns.resolve4(host).catch(() => [] as string[]),
        dns.resolve6(host).catch(() => [] as string[]),
      ]);
      ips = [...a4, ...a6];
    } catch {
      throw new BlockedUrlError("dns_fail");
    }
    if (ips.length === 0) throw new BlockedUrlError("no_dns_answer");
  }

  if (ips.some(isPrivateAddress)) throw new BlockedUrlError("private_target");
  return url;
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch a user-supplied URL with full SSRF validation on every hop.
 * Throws BlockedUrlError for blocked targets; returns the final Response
 * (caller reads the body).
 */
export async function safeFetch(
  raw: string,
  init?: RequestInit,
  maxHops = 3,
): Promise<{ res: Response; finalUrl: string }> {
  let current = raw;
  for (let hop = 0; hop <= maxHops; hop++) {
    const url = await assertSafeUrl(current);
    const res = await fetch(url.toString(), {
      ...init,
      redirect: "manual",
    });
    if (REDIRECT_CODES.has(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new BlockedUrlError("redirect_no_location");
      current = new URL(loc, url).toString();
      continue;
    }
    return { res, finalUrl: url.toString() };
  }
  throw new BlockedUrlError("too_many_redirects");
}
