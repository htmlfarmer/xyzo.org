/**
 * Auth-matrix ratchet test — CODEBASE_REVIEW_2026-09-26 BUG-4/6/20, FIX_NOTES §2.3.
 *
 * Historical failure class: write endpoints shipped PUBLIC by oversight
 * (apply-categorization → anyone rewrites any article's coords = map
 * poisoning; nn/refresh → unauthenticated detached process spawn;
 * sources/add → public SSRF seed for the root fetcher; problems approve).
 *
 * We can't retro-gate every public write today (app.js uses several of
 * them anonymously), so this test RATCHETS:
 *   1. Enumerate every write route (POST/PUT/DELETE/PATCH) registered via
 *      server.ts mounts.
 *   2. Classify each as authenticated (handler block references an auth
 *      mechanism) or OPEN.
 *   3. The OPEN set must match the pinned allowlist EXACTLY — a new
 *      unauthenticated write route fails CI until it's consciously added
 *      (with review) or gated.
 *   4. The MUST_GATE subset (documented criticals) is tracked: each fix
 *      that gates one of them requires updating the pin (loudly, here).
 *
 * Static only — never calls the live API, never touches the DB.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..", "..");
const SERVER = readFileSync(join(ROOT, "api/src/server.ts"), "utf8");

const AUTH_RX =
  /adminAuth|requireRole|verifyAdminKey|internalSecret|internal|checkInternal|sessionSecret|requireAuth|x-admin-key|key_hash/i;

/** Map every imported identifier -> routes/<file> (handles multi-import lines
 *  like `import { shutdownRoute, isSiteShutdown } from "./routes/shutdown"`
 *  and hyphenated filenames; the first-name-only parser bug already bit
 *  check-api-paths.sh once — see AGENTS session notes). */
function parseRouteImports(server: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of server.matchAll(/import\s*\{([^}]+)\}\s*from\s*"\.\/routes\/([\w.-]+)"/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.split(/\s+as\s+/).pop()?.trim();
      if (name) map.set(name, m[2]);
    }
  }
  for (const m of server.matchAll(/import\s+(\w+)\s+from\s*"\.\/routes\/([\w.-]+)"/g)) {
    map.set(m[1], m[2]);
  }
  return map;
}

interface Reg { file: string; method: string; path: string; line: number; target: string }

// Match: <identifier>.post("/path" or .post("/path", ... — quote may be ' ` "
const REG_INLINE = /\b(\w+)\.(get|post|put|delete|patch)\(\s*(['"`])([^'"`]+)\3/;
const REG_SOLO = /\b(\w+)\.(get|post|put|delete|patch)\(\s*$/;
const PATH_ON_NEXT = /^\s*(['"`])([^'"`]+)\1/;

function enumerateWriteRoutes(): { key: string; file: string; line: number; authenticated: boolean }[] {
  const mounts = [...SERVER.matchAll(/app\.route\("([^"]+)",\s*(\w+)(?:Route)?\)/g)]
    .map((m) => ({ prefix: m[1], varName: m[2] }));
  const imports = parseRouteImports(SERVER);

  const out: { key: string; file: string; line: number; authenticated: boolean }[] = [];
  for (const { prefix, varName } of mounts) {
    const f = imports.get(varName);
    if (!f) continue;
    const file = `api/src/routes/${f}.ts`;
    const abs = join(ROOT, file);
    if (!existsSync(abs)) continue;
    const lines = readFileSync(abs, "utf8").split("\n");

    const regs: Reg[] = [];
    for (let i = 0; i < lines.length; i++) {
      const mi = lines[i].match(REG_INLINE);
      if (mi && mi[1] === varName) {
        regs.push({ file, method: mi[2], path: mi[4], line: i, target: mi[1] });
        continue;
      }
      const ms = lines[i].match(REG_SOLO);
      if (ms && ms[1] === varName) {
        const nxt = i + 1 < lines.length ? lines[i + 1].match(PATH_ON_NEXT) : null;
        regs.push({ file, method: ms[2], path: nxt ? nxt[2] : "?", line: i, target: ms[1] });
      }
    }

    regs.forEach((r, idx) => {
      if (!["post", "put", "delete", "patch"].includes(r.method)) return;
      const end = idx + 1 < regs.length ? regs[idx + 1].line : Math.min(r.line + 40, lines.length);
      const block = lines.slice(r.line, end).join("\n");
      const full = `${prefix}/${r.path.replace(/^\//, "")}`.replace(/\/$/, "") || prefix;
      out.push({
        key: `${r.method.toUpperCase()} ${full}`,
        file,
        line: r.line + 1,
        authenticated: AUTH_RX.test(block),
      });
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Snapshot of write routes WITHOUT an auth check in their handler block.
 * Intentionally public (session/rate-limit governed) plus KNOWN CRITICALS
 * still awaiting a gate decision. Keep sorted; every change is a decision.
 */
const PINNED_UNAUTHENTICATED = [
  "POST /api/agent/contribute",
  "POST /api/ai/chat",
  "POST /api/ai/quick-flag",
  "POST /api/analytics/batch",
  "POST /api/analytics/client-error",
  "POST /api/analytics/log",
  "POST /api/analytics/presence",
  "POST /api/analytics/quick-flag",
  "POST /api/analytics/quick-flag/lookup",
  "POST /api/analytics/reaction",
  "POST /api/analytics/set-home",
  "POST /api/articles/:id/apply-categorization",
  "POST /api/articles/:id/credibility/compute",
  "POST /api/auto-discover",
  "POST /api/collab/:node_id/heartbeat",
  "POST /api/collab/jobs/:id/claim",
  "POST /api/collab/register",
  "POST /api/command",
  "POST /api/community/area-requests/:id/vote",
  "POST /api/community/requests/:id/vote",
  "POST /api/event-submissions",
  "POST /api/events/search",
  "POST /api/explore-region",
  "POST /api/explore-region/add-sources",
  "POST /api/feedback/bug-report",
  "POST /api/feedback/general-feedback",
  "POST /api/feedback/help-suggestion",
  "POST /api/feedback/source-suggestion",
  "POST /api/links",
  "POST /api/links/detect",
  "POST /api/links/feedback",
  "POST /api/links/manual",
  "POST /api/location-views",
  "POST /api/nn/feedback",
  "POST /api/pins",
  "POST /api/pins/:id/fast-suggest",
  "POST /api/pins/:id/re-evaluate",
  "POST /api/pins/:id/suggest-coords",
  "POST /api/pins/:id/suggest-location",
  "POST /api/pins/spread-positions",
  "POST /api/problems/:id/actions/:actionId/approve",
  "POST /api/recommend-news",
  "POST /api/search/log",
  "POST /api/search/failure",
  "POST /api/search/gap",
  "POST /api/search/journey",
  "POST /api/searches/save",
  // BUG-4 kill-switch complaint trigger: public by original design, but the
  // review flags it as the DoS vector (single complaint + attacker-controlled
  // denominator → shutdown). Must get rate-limit + trust signal (MUST_GATE).
  "POST /api/shutdown/complaint",
  "POST /api/sources/add",
  "POST /api/sources/bulk-add",
];

/** Subset flagged CRITICAL in CODEBASE_REVIEW / FIX_NOTES §2.3 — must end up
 *  authenticated. When a fix lands, REMOVE it from this list AND from the
 *  pinned snapshot above (the ratchet then proves the gate stayed in). */
const MUST_GATE = [
  "POST /api/articles/:id/apply-categorization", // BUG-6 map poisoning
  "POST /api/articles/:id/credibility/compute",   // BUG-6 unbounded public write
  "POST /api/problems/:id/actions/:actionId/approve", // BUG-6 moderation-by-anyone
  "POST /api/sources/add",                        // BUG-5 second-order SSRF
  "POST /api/sources/bulk-add",                   // BUG-5 second-order SSRF
  "POST /api/explore-region/add-sources",         // BUG-5 public source insertion
  "POST /api/shutdown/complaint",                 // BUG-4 kill-switch DoS trigger
];

describe("auth-matrix ratchet", () => {
  const routes = enumerateWriteRoutes();

  test("write-route enumeration is plausible (not a parser regression)", () => {
    // Sanity floor: this codebase has 40+ write routes. If the parser
    // silently returns almost nothing, the ratchet is vacuous → fail.
    expect(routes.length).toBeGreaterThanOrEqual(40);
  });

  test("unauthenticated write set matches the pinned snapshot", () => {
    const open = routes.filter((r) => !r.authenticated).map((r) => r.key);
    const missing = PINNED_UNAUTHENTICATED.filter((k) => !open.includes(k));
    const added = open.filter((k) => !PINNED_UNAUTHENTICATED.includes(k));
    expect(
      added,
      `NEW unauthenticated write route(s): ${JSON.stringify(added)}. Gate them ` +
      `with adminAuth()/requireRole or consciously add to the allowlist. ` +
      `(missing-from-pin: ${JSON.stringify(missing)})`,
    ).toEqual([]);
    expect(
      missing,
      `Pinned route(s) no longer enumerated unauthenticated — either gated ` +
      `(great: remove from BOTH lists) or renamed/removed: ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });

  test("MUST_GATE subset stays tracked until gated", () => {
    // Consistency: every MUST_GATE entry must still be listed in the pinned
    // snapshot (when a route gets properly gated it must be removed from
    // BOTH lists — the snapshot-equality test above enforces that step).
    for (const gate of MUST_GATE) {
      expect(PINNED_UNAUTHENTICATED, `MUST_GATE entry ${gate} missing from snapshot`).toContain(gate);
    }
  });

  test("every route file mounted in server.ts exists", () => {
    const mounts = [...SERVER.matchAll(/app\.route\("([^"]+)",\s*(\w+)(?:Route)?\)/g)];
    const imports = parseRouteImports(SERVER);
    const orphans: string[] = [];
    for (const [, , varName] of mounts) {
      const f = imports.get(varName);
      if (!f || !existsSync(join(ROOT, `api/src/routes/${f}.ts`))) orphans.push(varName);
    }
    expect(orphans, `mounted route vars with no file: ${JSON.stringify(orphans)}`).toEqual([]);
  });
});
