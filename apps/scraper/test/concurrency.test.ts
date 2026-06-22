import { describe, expect, it } from 'vitest';
import { mapLimit } from '../src/concurrency.js';

describe('mapLimit', () => {
  it('preserves input order in the result array', async () => {
    const items = [10, 30, 20, 5, 40];
    const results = await mapLimit(items, 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 2;
    });
    expect(results.map((r) => r.value)).toEqual([20, 60, 40, 10, 80]);
  });

  it('caps concurrency to the requested limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await mapLimit(items, 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    });

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('surfaces per-item errors without aborting the rest', async () => {
    const results = await mapLimit([1, 2, 3, 4], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    expect(results[0]?.value).toBe(1);
    expect(results[1]?.error?.message).toBe('boom');
    expect(results[2]?.value).toBe(3);
    expect(results[3]?.value).toBe(4);
  });

  it('handles empty input', async () => {
    const results = await mapLimit([], 4, async (n) => n);
    expect(results).toEqual([]);
  });

  it('rejects concurrency < 1', async () => {
    await expect(mapLimit([1], 0, async (n) => n)).rejects.toThrow(/concurrency must be ≥ 1/);
  });
});
