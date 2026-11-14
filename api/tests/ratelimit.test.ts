import { describe, expect, test, beforeEach } from "bun:test";
import { RateLimiter } from "../src/ratelimit";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ max: 3, windowMs: 60_000 });
  });

  test("allows up to max hits", () => {
    expect(limiter.check("1.1.1.1").allowed).toBe(true);
    expect(limiter.check("1.1.1.1").allowed).toBe(true);
    expect(limiter.check("1.1.1.1").allowed).toBe(true);
  });

  test("blocks the (max+1)th hit", () => {
    limiter.check("1.1.1.1");
    limiter.check("1.1.1.1");
    limiter.check("1.1.1.1");
    const result = limiter.check("1.1.1.1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  test("isolates buckets per IP", () => {
    limiter.check("1.1.1.1");
    limiter.check("1.1.1.1");
    limiter.check("1.1.1.1");
    expect(limiter.check("2.2.2.2").allowed).toBe(true);
  });

  test("window resets after expiry", async () => {
    const fast = new RateLimiter({ max: 1, windowMs: 10 });
    expect(fast.check("1.1.1.1").allowed).toBe(true);
    expect(fast.check("1.1.1.1").allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(fast.check("1.1.1.1").allowed).toBe(true);
  });
});