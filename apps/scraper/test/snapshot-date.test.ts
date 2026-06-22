import { describe, expect, it } from 'vitest';
import { todayUtcIsoDate } from '../src/snapshot-date.js';

describe('todayUtcIsoDate', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(todayUtcIsoDate(new Date('2026-06-21T15:30:00Z'))).toBe('2026-06-21');
  });

  it('uses UTC, not the local timezone', () => {
    // 2026-06-21T23:30Z in any non-UTC offset reads as a different local date,
    // but the snapshot must agree across hosts.
    expect(todayUtcIsoDate(new Date('2026-06-21T23:30:00Z'))).toBe('2026-06-21');
    expect(todayUtcIsoDate(new Date('2026-06-22T00:30:00Z'))).toBe('2026-06-22');
  });

  it('zero-pads single-digit months/days', () => {
    expect(todayUtcIsoDate(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-05');
  });
});
