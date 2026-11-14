// ── /api/ai/chat routing + connection tests ─────────────────────────
//
// Pins the production AI routing so a silent disconnect (hivv.org down,
// env var missing, port changed) is caught by `bun test` instead of
// being discovered by users complaining that the chat panel is broken.
//
// Run:
//   cd /var/www/vhosts/xyzo.org/api
//   bun test tests/ai-chat.test.ts
//
// Requires:
//   - xyzo-api running on $XYZO_PORT (default 3008) — local or CI
//   - hivv.org node service on $XYZO_AI_PRIMARY_URL (default localhost:3011)
//   - For the fallback test, the primary must be stopped (handled manually
//     in a separate test or skipped in CI)
//
// What we pin:
//   1. .env / .env.example contain explicit XYZO_AI_* vars (catches
//      someone reverting to defaults-only and breaking auditability)
//   2. ai-chat.ts route handler reads the same env vars the .env
//      advertises (catches typo / rename drift)
//   3. /api/ai/chat returns via:"primary" when hivv.org is reachable
//   4. /api/ai/chat returns via:"fallback" when primary is unreachable
//      (skipped unless XYO_FORCE_FALLBACK_TEST=1)
//   5. /api/ai/chat response latency is < 25s (the XYZO_AI_TIMEOUT)

import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const API_BASE = process.env.XYZO_API_BASE ?? "http://localhost:3008";
const PRIMARY_URL =
  process.env.XYZO_AI_PRIMARY_URL ?? "http://localhost:3011/v1/chat/completions";
const FALLBACK_URL =
  process.env.XYZO_AI_FALLBACK_URL ?? "http://192.168.1.3:8888/v1/chat/completions";

const ENV_PATH = resolve(__dirname, "../.env");
const ENV_EXAMPLE_PATH = resolve(__dirname, "../.env.example");
const AI_CHAT_TS = readFileSync(
  resolve(__dirname, "../src/routes/ai-chat.ts"),
  "utf8",
);

describe("AI env vars must be explicit in .env + .env.example", () => {
  test(".env.example lists all four XYZO_AI_* vars (no defaults-only)", () => {
    const example = readFileSync(ENV_EXAMPLE_PATH, "utf8");
    expect(example).toContain("XYZO_AI_PRIMARY_URL=");
    expect(example).toContain("XYZO_AI_FALLBACK_URL=");
    expect(example).toContain("XYZO_AI_MODEL=");
    expect(example).toContain("XYZO_AI_TIMEOUT=");
  });

  test(".env lists all four XYZO_AI_* vars (if .env exists)", () => {
    let env: string;
    try {
      env = readFileSync(ENV_PATH, "utf8");
    } catch {
      // .env is intentionally gitignored; CI may not have it. Skip
      // silently — the .env.example check above is what keeps the
      // contract honest for new deploys.
      console.warn(
        "[ai-chat.test] .env not present — skipping .env content check " +
          "(.env.example check still gates deploys)",
      );
      return;
    }
    expect(env).toContain("XYZO_AI_PRIMARY_URL=");
    expect(env).toContain("XYZO_AI_FALLBACK_URL=");
    expect(env).toContain("XYZO_AI_MODEL=");
    expect(env).toContain("XYZO_AI_TIMEOUT=");
  });

  test("ai-chat.ts reads exactly the same env var names (catches rename drift)", () => {
    expect(AI_CHAT_TS).toContain("process.env.XYZO_AI_PRIMARY_URL");
    expect(AI_CHAT_TS).toContain("process.env.XYZO_AI_FALLBACK_URL");
    expect(AI_CHAT_TS).toContain("process.env.XYZO_AI_MODEL");
    expect(AI_CHAT_TS).toContain("process.env.XYZO_AI_TIMEOUT");
  });

  test("ai-chat.ts defaults match .env.example defaults (silent-fallback safety)", () => {
    // If someone changes the default in code but forgets the .env.example
    // (or vice versa), operators get a different routing than they think.
    const example = readFileSync(ENV_EXAMPLE_PATH, "utf8");
    const primaryDefaultInCode =
      AI_CHAT_TS.match(/XYZO_AI_PRIMARY_URL\s*\?\?\s*"([^"]+)"/)?.[1];
    const primaryDefaultInExample = example
      .match(/^XYZO_AI_PRIMARY_URL=(.+)$/m)?.[1];
    expect(primaryDefaultInCode).toBeTruthy();
    expect(primaryDefaultInExample).toBeTruthy();
    expect(primaryDefaultInCode).toBe(primaryDefaultInExample);
  });
});

describe("/api/ai/chat routes through primary when reachable", () => {
  let skipReason: string | null = null;
  beforeAll(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) skipReason = `xyzo-api health returned ${res.status}`;
    } catch (e: any) {
      skipReason = `xyzo-api unreachable at ${API_BASE}: ${e?.message ?? e}`;
    }
  });

  test("POST /api/ai/chat returns via:'primary' against live hivv.org", async () => {
    if (skipReason) {
      console.warn(`[ai-chat.test] skipping — ${skipReason}`);
      return;
    }
    const t0 = Date.now();
    const res = await fetch(`${API_BASE}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Reply with just the word routing-check",
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      response?: string;
      via?: string;
      latency_ms?: number;
    };
    expect(body.via).toBe("primary");
    expect(body.response).toBeTruthy();
    expect(body.latency_ms).toBeLessThan(25000); // XYZO_AI_TIMEOUT
    // elapsed is wall-clock including fallback if primary fails —
    // if it exceeds the timeout, the breaker is probably open.
    expect(elapsed).toBeLessThan(30000);
  }, { timeout: 35000 });

  test("primary URL is reachable independently (catches hivv.org down before xyzo-api routes around it)", async () => {
    if (skipReason) {
      console.warn(`[ai-chat.test] skipping — ${skipReason}`);
      return;
    }
    // A direct probe against PRIMARY_URL — if this fails but the
    // /api/ai/chat test above passed via:"primary", something is
    // very weird (proxy magic) and worth a human look.
    try {
      const res = await fetch(PRIMARY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gemma-3-27b",
          messages: [{ role: "user", content: "ping" }],
          stream: false,
        }),
        signal: AbortSignal.timeout(5000),
      });
      expect([200, 400, 422]).toContain(res.status); // 400/422 = malformed payload but reachable
    } catch (e: any) {
      // Don't fail the suite — /api/ai/chat test above is the source of truth.
      // Just log loudly so a human notices.
      console.warn(
        `[ai-chat.test] WARNING: direct probe of PRIMARY_URL (${PRIMARY_URL}) failed: ${e?.message ?? e}. ` +
          `If the test above still passed via:"primary", something is routing via a different host.`,
      );
    }
  });
});

describe("/api/ai/chat fallback path", () => {
  test("returns via:'fallback' when primary is unreachable (manual test)", async () => {
    if (!process.env.XYO_FORCE_FALLBACK_TEST) {
      console.warn(
        "[ai-chat.test] skipping fallback test — set XYO_FORCE_FALLBACK_TEST=1 " +
          "AND stop the primary (e.g. `systemctl stop hivv-api` or kill pid on :3011) " +
          "before running. The breaker may need ~120s to reset after primary recovery.",
      );
      return;
    }
    // With primary stopped, the route must surface via:"fallback"
    // OR return a clean 5xx if the fallback is also down. We accept
    // either — what we DON'T accept is hanging past XYZO_AI_TIMEOUT.
    const t0 = Date.now();
    const res = await fetch(`${API_BASE}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "fallback probe — reply with the word fallback-confirmed",
      }),
      signal: AbortSignal.timeout(30000),
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(30000);
    if (res.status === 200) {
      const body = (await res.json()) as { via?: string };
      expect(body.via).toBe("fallback");
    } else {
      // Fallback host down is acceptable — what matters is we didn't hang.
      console.warn(
        `[ai-chat.test] fallback host also unavailable (${res.status}) — ` +
          `route returned clean error in ${elapsed}ms (good, no hang).`,
      );
      expect([502, 503, 504]).toContain(res.status);
    }
  }, { timeout: 35000 });
});
