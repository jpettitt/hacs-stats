import { describe, expect, it } from 'vitest';
import { RateLimitGuard, observationFromRestHeaders } from '../src/rate-limit.js';

describe('observationFromRestHeaders', () => {
  it('parses GitHub REST rate-limit headers', () => {
    const obs = observationFromRestHeaders(
      new Headers({ 'x-ratelimit-remaining': '4567', 'x-ratelimit-reset': '1700000000' }),
    );
    expect(obs).toEqual({ remaining: 4567, resetAtMs: 1700000000_000 });
  });

  it('returns null when headers are missing', () => {
    expect(observationFromRestHeaders(new Headers())).toBeNull();
    expect(observationFromRestHeaders(new Headers({ 'x-ratelimit-remaining': '1' }))).toBeNull();
  });

  it('returns null when the header values are non-numeric', () => {
    expect(
      observationFromRestHeaders(
        new Headers({ 'x-ratelimit-remaining': 'lots', 'x-ratelimit-reset': 'soon' }),
      ),
    ).toBeNull();
  });
});

describe('RateLimitGuard', () => {
  it('does not sleep when remaining is above the threshold', async () => {
    const slept: number[] = [];
    const g = new RateLimitGuard({
      threshold: 50,
      now: () => 1_000_000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    g.observe({ remaining: 200, resetAtMs: 2_000_000 });
    await g.waitIfNeeded();
    expect(slept).toEqual([]);
  });

  it('sleeps until the reset window when remaining dips below threshold', async () => {
    const slept: number[] = [];
    const g = new RateLimitGuard({
      threshold: 50,
      now: () => 1_000_000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    g.observe({ remaining: 10, resetAtMs: 1_005_000 });
    await g.waitIfNeeded();
    // pauseUntilMs - now + 1s cushion = 5000 + 1000 = 6000
    expect(slept).toEqual([6000]);
  });

  it('the latest pause-until wins (never pulls in)', async () => {
    const slept: number[] = [];
    const g = new RateLimitGuard({
      threshold: 50,
      now: () => 1_000_000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    g.observe({ remaining: 10, resetAtMs: 1_010_000 }); // farther
    g.observe({ remaining: 5, resetAtMs: 1_005_000 }); // nearer — should not override
    await g.waitIfNeeded();
    expect(slept).toEqual([11_000]); // 10s wait + 1s cushion
  });

  it('snapshot exposes last observation', () => {
    const g = new RateLimitGuard();
    g.observe({ remaining: 4321, resetAtMs: 99 });
    expect(g.snapshot().remaining).toBe(4321);
  });
});
