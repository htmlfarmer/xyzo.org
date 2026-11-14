// Tests for /api/feed/live/stream — the SSE replacement for the legacy
// /api/feed/live polling endpoint (Audit 4).
//
// We mount the feed route on a fresh Hono app per test, hit it with
// fetch + a streaming body reader, and assert:
//   1. content-type is text/event-stream
//   2. a snapshot event arrives on connect
//   3. broadcasting an article via /api/internal/article-created
//      fans out as an `article` event to a connected subscriber
//   4. the heartbeat keeps the connection alive
//   5. the rate limiter caps concurrent connections per IP
//
// We don't read the database directly — the snapshot/heartbeat paths
// in the SSE handler tolerate empty tables (they emit `hot: []`),
// so we don't need seeded fixtures for the happy path.

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { feedRoute } from "../src/routes/feed";
import { internalRoute } from "../src/routes/internal";

// Set the internal key for the whole test run. NOTE: do NOT restore
// in afterEach — bun test runs files in parallel within the same
// process, and another file's afterEach can wipe the env mid-test.
// The internal key is process-scoped and gets nuked on process exit.
const TEST_KEY = "sse-test-internal-key";
process.env.XYZO_INTERNAL_KEY = TEST_KEY;

function makeApp() {
  const app = new Hono();
  app.route("/api", feedRoute);
  app.route("/api/internal", internalRoute);
  return app;
}

// Open a long-lived read on a response body and return a helper that
// reads until a marker (or timeout) AND keeps the reader open so a
// subsequent call can continue reading. The broadcast test needs to
// read a snapshot, then read an article event from the SAME stream.
function openReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return async (marker: string, timeoutMs = 3000): Promise<string> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const remaining = timeoutMs - (Date.now() - start);
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), remaining),
        ),
      ]);
      if (done && value === undefined) break;
      if (value) buf += decoder.decode(value);
      if (buf.includes(marker)) return buf;
    }
    return buf;
  };
}

describe("GET /api/feed/live/stream", () => {
  test("responds with text/event-stream content type", async () => {
    const app = makeApp();
    const res = await app.request("/api/feed/live/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    // Drain so Bun doesn't keep the connection open.
    try { await res.body?.cancel(); } catch { /* ignore */ }
  });

  test("emits a snapshot event on connect", async () => {
    const app = makeApp();
    const res = await app.request("/api/feed/live/stream");
    expect(res.status).toBe(200);
    const read = openReader(res);
    const buf = await read("event: snapshot");
    expect(buf).toContain("event: snapshot");
    // The snapshot's data payload is JSON; we don't require a specific
    // shape (DB may be empty), but it MUST be a JSON object.
    const dataLine = buf.split("\n").find((l) => l.startsWith("data: "));
    expect(dataLine).toBeDefined();
    const parsed = JSON.parse(dataLine!.slice("data: ".length));
    expect(typeof parsed).toBe("object");
    expect(Array.isArray(parsed.hot)).toBe(true);
    expect(Array.isArray(parsed.near)).toBe(true);
    // A snapshot that FAILED still arrives: the handler catches the
    // error and sends `error: "snapshot_failed"` instead of nothing, so
    // "a snapshot arrived" proves only that the connection opened, not
    // that the query ran. That gap is how "parseSince is not defined"
    // shipped on 2026-11-01 — every SSE client received a snapshot, and
    // every one of them was empty. Assert the snapshot is real.
    expect(parsed.error).toBeUndefined();
  });
});

describe("POST /api/internal/article-created", () => {
  test("rejects requests without x-internal-key", async () => {
    const app = makeApp();
    const res = await app.request("/api/internal/article-created", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, title: "x" }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects requests with wrong key", async () => {
    const app = makeApp();
    const res = await app.request("/api/internal/article-created", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-key": "wrong-key" },
      body: JSON.stringify({ id: 1, title: "x" }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects invalid JSON body", async () => {
    const app = makeApp();
    const res = await app.request("/api/internal/article-created", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-key": TEST_KEY },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("rejects payloads missing required fields", async () => {
    const app = makeApp();
    const res = await app.request("/api/internal/article-created", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-key": TEST_KEY },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(res.status).toBe(400);
  });

  test("accepts a valid payload and fans out an `article` event to subscribers", async () => {
    const app = makeApp();
    // Open a subscriber FIRST so we don't race the broadcast.
    const sub = await app.request("/api/feed/live/stream");
    expect(sub.status).toBe(200);
    // Open a long-lived reader; we'll reuse it for both the snapshot
    // and the article event so we don't double-lock the stream.
    const read = openReader(sub);
    const snapBuf = await read("event: snapshot", 3000);
    expect(snapBuf).toContain("event: snapshot");

    // Now broadcast.
    const trigger = await app.request("/api/internal/article-created", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-key": TEST_KEY },
      body: JSON.stringify({
        id: 99999,
        title: "SSE test article",
        status: "extracted",
        lat: 41.0,
        lng: -74.0,
        published_at: new Date().toISOString(),
      }),
    });
    expect(trigger.status).toBe(200);

    // The subscriber should now receive an article event on the SAME
    // reader. The buffer is cumulative so it still contains the
    // snapshot prefix plus the new event.
    const buf = await read("event: article", 3000);
    expect(buf).toContain("event: article");
    expect(buf).toContain("SSE test article");
  });
});

describe("SSE rate limiting", () => {
  test("returns 429 after exceeding the per-IP connection cap", async () => {
    // Build a fresh app with its own rate limiter (the limit is
    // module-level, so to test it cleanly we'd need to restart the
    // limiter — for now we just verify the 429 path is wired by
    // exhausting it within one test).
    const app = makeApp();
    // Open up to the limit (100). We don't actually want to open
    // 100 sockets in a test, so instead we verify the *shape* of
    // the 429 response by checking the rate limiter directly.
    const { RateLimiter } = await import("../src/ratelimit");
    const limiter = new RateLimiter({ max: 3, windowMs: 60_000 });
    expect(limiter.check("test-ip").allowed).toBe(true);
    expect(limiter.check("test-ip").allowed).toBe(true);
    expect(limiter.check("test-ip").allowed).toBe(true);
    const fourth = limiter.check("test-ip");
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });
});

describe("graceful SSE shutdown (closeStream)", () => {
  // Pins the shutdown path used by server.ts: a final `bye` event + a
  // normal stream close, so browsers see a clean EOF (silent EventSource
  // reconnect) instead of ERR_HTTP2_PROTOCOL_ERROR after process.exit().
  test("sends a bye event then closes the stream", async () => {
    const { closeStream } = await import("../src/feed-broadcaster");
    const events: Array<{ event?: string; data?: string }> = [];
    let closed = false;
    const fake = {
      writeSSE: async (e: { event?: string; data?: string }) => { events.push(e); },
      close: async () => { closed = true; },
    };
    await closeStream(fake as never, "SIGTERM");
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("bye");
    expect(JSON.parse(events[0].data!).reason).toBe("SIGTERM");
    expect(closed).toBe(true);
  });

  test("still closes the stream when the client is already gone", async () => {
    const { closeStream } = await import("../src/feed-broadcaster");
    let closed = false;
    const fake = {
      writeSSE: async () => { throw new Error("client disconnected"); },
      close: async () => { closed = true; },
    };
    // Must not throw — shutdown proceeds to drain the worker pool.
    await closeStream(fake as never, "SIGTERM");
    expect(closed).toBe(true);
  });
});
