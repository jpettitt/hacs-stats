import { describe, expect, it } from 'vitest';
import { renderLineChart } from '../src/svg-chart.js';

describe('renderLineChart', () => {
  it('shows an empty-state SVG when given no points', () => {
    const svg = renderLineChart([]);
    expect(svg).toContain('<svg');
    expect(svg).toContain('no data yet');
    expect(svg).not.toContain('<path');
  });

  it('shows an empty-state SVG when given one point (need 2+ to draw a line)', () => {
    const svg = renderLineChart([{ date: '2026-06-22', value: 100 }]);
    expect(svg).toContain('one data point');
    expect(svg).not.toContain('<path');
  });

  it('draws a step-after path for ≥ 2 points (M followed by alternating L commands)', () => {
    const svg = renderLineChart([
      { date: '2026-06-20', value: 100 },
      { date: '2026-06-21', value: 120 },
      { date: '2026-06-22', value: 115 },
    ]);
    // step-after for 3 points emits one M and then L commands for each
    // horizontal-then-vertical pair: M L L L L (= 1 M + 4 L). We just
    // assert there's a single M and "enough L's" rather than pinning
    // an exact count — d3 could in theory emit H/V shorthand later.
    const m = (svg.match(/M\d/g) ?? []).length;
    const l = (svg.match(/L\d/g) ?? []).length;
    expect(m).toBe(1);
    expect(l).toBeGreaterThanOrEqual(2);
  });

  it('emits y-axis labels using k-suffix for large numbers', () => {
    const svg = renderLineChart([
      { date: '2026-06-20', value: 10000 },
      { date: '2026-06-22', value: 21500 },
    ]);
    // d3's tick algorithm picks round numbers; we just assert the
    // k-suffix formatting is applied to the largest tick.
    expect(svg).toMatch(/>2[0-5]k</);
  });

  it('drops points with unparseable date strings rather than rendering NaN paths', () => {
    const svg = renderLineChart([
      { date: '2026-06-20<script>', value: 1 },
      { date: '2026-06-22', value: 2 },
      { date: '2026-06-23', value: 3 },
    ]);
    // Bad row was filtered out; remaining 2 rendered cleanly.
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('NaN');
    expect(svg).toContain('<path');
  });

  it('shows empty-state SVG when every point has a bad date', () => {
    const svg = renderLineChart([
      { date: 'not-a-date', value: 1 },
      { date: 'also-not', value: 2 },
    ]);
    expect(svg).toContain('no data yet');
    expect(svg).not.toContain('<path');
  });

  it('pins y-axis to 0 by default (zeroBase)', () => {
    const svg = renderLineChart([
      { date: '2026-06-20', value: 100 },
      { date: '2026-06-22', value: 120 },
    ]);
    expect(svg).toMatch(/class="chart-axis">0</);
  });

  it('floats y-axis when zeroBase=false (the 3y-truncated case)', () => {
    const svg = renderLineChart(
      [
        { date: '2026-06-20', value: 100 },
        { date: '2026-06-22', value: 120 },
      ],
      { zeroBase: false },
    );
    // 0 should NOT appear as a tick label when the floor is floated.
    expect(svg).not.toMatch(/class="chart-axis">0</);
  });

  it('uses the provided className + aria-label', () => {
    const svg = renderLineChart(
      [
        { date: '2026-06-20', value: 1 },
        { date: '2026-06-22', value: 2 },
      ],
      { className: 'mychart', ariaLabel: 'Stars trend' },
    );
    expect(svg).toContain('class="mychart"');
    expect(svg).toContain('aria-label="Stars trend"');
  });
});
