import { getDb } from "./db";

export type AdminRole = "editorial" | "rss_ingest" | "super";

export interface ParsedAdminKey {
  keyId: string;
  secret: string;
  fullSecret: string;
}

export function parseAdminKey(header: string | null): ParsedAdminKey | null {
  if (!header) return null;
  const idx = header.indexOf(".");
  if (idx === -1) return null;
  const keyId = header.slice(0, idx);
  const secret = header.slice(idx + 1);
  if (!keyId || !secret) return null;
  return { keyId, secret, fullSecret: header };
}

export interface AdminAuth {
  name: string;
  role: AdminRole;
}

export async function verifyAdminKey(parsed: ParsedAdminKey): Promise<AdminAuth | null> {
  const sql = getDb();
  const rows = await sql<{ name: string; role: AdminRole; key_hash: string }[]>`
    SELECT name, role, key_hash
    FROM admin_keys
    WHERE key_id = ${parsed.keyId} AND revoked_at IS NULL
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const row = rows[0];
  const ok = await Bun.password.verify(parsed.fullSecret, row.key_hash);
  if (!ok) return null;
  return { name: row.name, role: row.role };
}

export function requireRole(auth: AdminAuth | null, allowed: AdminRole[]): boolean {
  if (!auth) return false;
  if (auth.role === "super") return true;
  return allowed.includes(auth.role);
}

// ── Shared adminAuth middleware ────────────────────────────────────
//
// Wraps parseAdminKey → verifyAdminKey → requireRole into a single
// helper used by every admin-gated route. Returns either:
//   { ok: true, auth }                            — caller proceeds
//   { ok: false, response }                       — caller does `return gate.response`
//
// role defaults to ["super"] because the /admin/* namespace is for
// operator-facing endpoints (debug toggles, breaker reset, etc.) —
// never exposed to unauthenticated callers. Other namespaces
// (/analytics/*, /sources/discover/*, /performance/*) pass the role
// explicitly to express their sensitivity.
//
// Promoted from admin.ts:24-39 (Tier 1.1 audit fix) so non-/admin
// routes can reuse the same gate without copy-paste.
export type AdminAuthResult =
  | { ok: true; auth: AdminAuth }
  | { ok: false; response: Response };

export async function adminAuth(
  c: { req: { header: (name: string) => string | undefined } },
  role: AdminRole[] = ["super"],
): Promise<AdminAuthResult> {
  const parsed = parseAdminKey(c.req.header("x-admin-key") ?? null);
  if (!parsed) return { ok: false, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
  const auth = await verifyAdminKey(parsed);
  if (!auth) return { ok: false, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
  if (!requireRole(auth, role)) return { ok: false, response: Response.json({ error: "forbidden" }, { status: 403 }) };
  return { ok: true, auth };
}
