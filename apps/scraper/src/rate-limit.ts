/**
 * GitHub rate-limit guardian.
 *
 * Each successful response carries `x-ratelimit-remaining` and
 * `x-ratelimit-reset` (REST), or a `rateLimit { remaining resetAt }` block
 * (GraphQL). We feed those values into one shared `RateLimitGuard` which
 *
 *   - lets requests through as long as remaining > threshold (default 50)
 *   - blocks new requests until `resetAt` once remaining dips below
 *
 * With N concurrent workers, this can overshoot the threshold by up to N
 * because each worker checks the gate before its response updates the
 * counter. We pick the threshold high enough (50 > our typical 12-worker
 * concurrency) that overshoot can't actually exhaust the budget.
 */
export interface RateLimitObservation {
  /** Remaining requests in the current window. */
  remaining: number;
  /** Wall-clock epoch ms when the window resets. */
  resetAtMs: number;
}

export interface RateLimitGuardOptions {
  /** Resume requesting only when remaining > this. Default 50. */
  threshold?: number;
  /** Inject for tests. Defaults to Date.now(). */
  now?: () => number;
  /** Inject for tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export class RateLimitGuard {
  private threshold: number;
  private nowFn: () => number;
  private sleepFn: (ms: number) => Promise<void>;
  private pauseUntilMs = 0;
  private lastSeenRemaining = Number.POSITIVE_INFINITY;

  constructor(opts: RateLimitGuardOptions = {}) {
    this.threshold = opts.threshold ?? 50;
    this.nowFn = opts.now ?? (() => Date.now());
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Call BEFORE issuing a request. Sleeps until the rate window resets if needed. */
  async waitIfNeeded(): Promise<void> {
    const now = this.nowFn();
    if (now < this.pauseUntilMs) {
      // Small cushion (1s) so the first request after the reset can't race ahead.
      await this.sleepFn(this.pauseUntilMs - now + 1000);
    }
  }

  /** Call AFTER a response with the rate-limit numbers it carried. */
  observe(o: RateLimitObservation): void {
    this.lastSeenRemaining = o.remaining;
    if (o.remaining <= this.threshold) {
      // Push the pause out if multiple low-remaining observations arrive close
      // together — never pull it in.
      this.pauseUntilMs = Math.max(this.pauseUntilMs, o.resetAtMs);
    }
  }

  /** Inspection helpers (used by tests + the orchestrator's final log line). */
  snapshot(): { remaining: number; pausedUntilMs: number } {
    return { remaining: this.lastSeenRemaining, pausedUntilMs: this.pauseUntilMs };
  }
}

/** Parse REST `x-ratelimit-*` headers into an observation. */
export function observationFromRestHeaders(headers: Headers): RateLimitObservation | null {
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  if (remaining === null || reset === null) return null;
  const remainingNum = Number(remaining);
  const resetNum = Number(reset);
  if (!Number.isFinite(remainingNum) || !Number.isFinite(resetNum)) return null;
  return { remaining: remainingNum, resetAtMs: resetNum * 1000 };
}
