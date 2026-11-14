// ── AI circuit breaker ──────────────────────────────────────────────
//
// Tracks recent failures to the local AI endpoint
// (XYZO_AI_URL, default 192.168.1.3:8888/chat/stream). When too many
// failures happen in a short window, the breaker opens and short-
// circuits all calls until the cool-down elapses. This keeps a downed
// AI endpoint from making every user-facing route hang on a 25-second
// timeout.
//
// Process-local state — the API is a single Bun process so this is
// sufficient. If we ever go multi-process, swap this for a Redis
// counter.

interface BreakerConfig {
  windowMs: number;        // How far back failures count
  threshold: number;       // Failures in `windowMs` that trip the breaker
  cooldownMs: number;      // How long the breaker stays open
}

const DEFAULT: BreakerConfig = {
  windowMs: 60_000,
  threshold: 3,
  cooldownMs: 120_000,
};

class CircuitBreaker {
  private failures: number[] = [];
  private openUntil = 0;
  private lastError = "";
  private totalCalls = 0;
  private totalFailures = 0;
  private totalShortCircuits = 0;
  private lastSuccessAt = 0;
  private lastFailureAt = 0;
  private recentErrors: Array<{ at: number; msg: string }> = [];

  constructor(private config: BreakerConfig = DEFAULT) {}

  /** True if calls should proceed. */
  shouldAllow(): boolean {
    return Date.now() >= this.openUntil;
  }

  /** Mark a successful call. Closes the breaker and clears history. */
  recordSuccess(): void {
    if (this.failures.length > 0 || this.openUntil > 0) {
      this.failures = [];
      this.openUntil = 0;
      console.log("[ai-breaker] CLOSED — endpoint healthy");
    }
    this.totalCalls++;
    this.lastSuccessAt = Date.now();
  }

  /** Mark a failed call. Opens the breaker if threshold crossed. */
  recordFailure(err: string): void {
    const now = Date.now();
    this.failures = this.failures.filter(
      (t) => now - t < this.config.windowMs,
    );
    this.failures.push(now);
    this.totalCalls++;
    this.totalFailures++;
    this.lastError = (err || "").slice(0, 200);
    this.lastFailureAt = now;
    this.recentErrors.push({ at: now, msg: this.lastError });
    if (this.recentErrors.length > 10) this.recentErrors.shift();
    if (this.failures.length >= this.config.threshold && this.openUntil < now) {
      this.openUntil = now + this.config.cooldownMs;
      console.warn(
        `[ai-breaker] OPEN: ${this.failures.length} failures in ${this.config.windowMs}ms — skipping AI for ${this.config.cooldownMs}ms. last=${this.lastError}`,
      );
    }
  }

  /** Record that we short-circuited (didn't even try). */
  recordShortCircuit(): void {
    this.totalShortCircuits++;
  }

  snapshot(): {
    open: boolean;
    open_for_ms: number;
    recent_failures: number;
    fail_window_ms: number;
    fail_threshold: number;
    cooldown_ms: number;
    last_error: string;
    total_calls: number;
    total_failures: number;
    total_short_circuits: number;
    last_success_at: string | null;
    last_failure_at: string | null;
    recent_errors: Array<{ at: string; msg: string }>;
    success_rate: number;
  } {
    const now = Date.now();
    const remaining = Math.max(0, this.openUntil - now);
    return {
      open: remaining > 0,
      open_for_ms: remaining,
      recent_failures: this.failures.length,
      fail_window_ms: this.config.windowMs,
      fail_threshold: this.config.threshold,
      cooldown_ms: this.config.cooldownMs,
      last_error: this.lastError,
      total_calls: this.totalCalls,
      total_failures: this.totalFailures,
      total_short_circuits: this.totalShortCircuits,
      last_success_at: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      last_failure_at: this.lastFailureAt ? new Date(this.lastFailureAt).toISOString() : null,
      recent_errors: this.recentErrors.map(e => ({
        at: new Date(e.at).toISOString(),
        msg: e.msg,
      })),
      success_rate: this.totalCalls > 0
        ? Math.round(((this.totalCalls - this.totalFailures) / this.totalCalls) * 10000) / 100
        : 100,
    };
  }

  /** Force close (admin override). */
  forceClose(): void {
    this.failures = [];
    this.openUntil = 0;
    this.lastError = "";
    this.recentErrors = [];
    console.log("[ai-breaker] force-closed by admin");
  }
}

export const aiBreaker = new CircuitBreaker();

/** Run a callable under the breaker. Returns its result, or undefined
 *  if the breaker short-circuited. On throw, records failure and
 *  re-raises the original error so the caller can decide what to do.
 */
export async function withBreaker<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  if (!aiBreaker.shouldAllow()) {
    aiBreaker.recordShortCircuit();
    console.debug(`[ai-breaker] short-circuit ${label}`);
    return undefined;
  }
  try {
    const out = await fn();
    aiBreaker.recordSuccess();
    return out;
  } catch (e) {
    aiBreaker.recordFailure((e as Error)?.message ?? String(e));
    throw e;
  }
}