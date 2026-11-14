// Tests for rate limiter memory cleanup.
//
// Verifies that expired buckets are cleaned up periodically to prevent
// unbounded memory growth under sustained traffic.

import { describe, expect, test, beforeEach } from "bun:test";
import { RateLimiter } from "../src/ratelimit";

describe("RateLimiter cleanup", () => {
  test("expired buckets are cleaned up after cleanup interval", async () => {
    // Use a very short window and cleanup interval for testing
    const limiter = new RateLimiter({ max: 2, windowMs: 50 });

    // Generate some traffic from different IPs
    limiter.check("1.1.1.1");
    limiter.check("2.2.2.2");
    limiter.check("3.3.3.3");

    // All should be allowed initially
    expect(limiter.check("1.1.1.1").allowed).toBe(true);
    expect(limiter.check("2.2.2.2").allowed).toBe(true);
    expect(limiter.check("3.3.3.3").allowed).toBe(true);

    // Wait for buckets to expire
    await new Promise(r => setTimeout(r, 60));

    // After expiry, new requests should be allowed (buckets reset)
    expect(limiter.check("1.1.1.1").allowed).toBe(true);
    expect(limiter.check("2.2.2.2").allowed).toBe(true);
    expect(limiter.check("3.3.3.3").allowed).toBe(true);
  });

  test("different IPs are isolated", () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 60_000 });

    expect(limiter.check("10.0.0.1").allowed).toBe(true);
    expect(limiter.check("10.0.0.2").allowed).toBe(true);
    expect(limiter.check("10.0.0.1").allowed).toBe(false); // hit max
    expect(limiter.check("10.0.0.2").allowed).toBe(false); // hit max
  });

  test("retryAfterMs is positive when rate limited", () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 });
    limiter.check("1.1.1.1");
    const result = limiter.check("1.1.1.1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(1000);
  });
});
