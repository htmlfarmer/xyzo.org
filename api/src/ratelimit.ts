export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

interface Bucket {
  count: number;
  expiresAt: number;
}

export interface RateLimiterOptions {
  max: number;
  windowMs: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(private readonly opts: RateLimiterOptions) {}

  private sweepExpired(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, b] of this.buckets) {
      if (b.expiresAt <= now) this.buckets.delete(k);
    }
  }

  check(key: string): RateLimitResult {
    const now = Date.now();
    this.sweepExpired(now);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.expiresAt <= now) {
      this.buckets.set(key, { count: 1, expiresAt: now + this.opts.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (bucket.count < this.opts.max) {
      bucket.count++;
      return { allowed: true, retryAfterMs: 0 };
    }
    return { allowed: false, retryAfterMs: bucket.expiresAt - now };
  }
}

export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}