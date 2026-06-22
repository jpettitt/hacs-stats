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

  it('draws a path with one M and one or more L commands for ≥ 2 points', () => {
    const svg = renderLineChart([
      { date: '2026-06-20', value: 100 },
      { date: '2026-06-21', value: 120 },
      { date: '2026-06-22', value: 115 },
    ]);
    const m = (svg.match(/M\d/g) ?? []).length;
    const l = (svg.match(/L\d/g) ?? []).length;
    expect(m).toBe(1);
    expect(l).toBe(2);
  });

  it('emits y-axis labels using k-suffix for large numbers', () => {
    const svg = renderLineChart([
      { date: '2026-06-20', value: 10000 },
      { date: '2026-06-22', value: 21500 },
    ]);
    expect(svg).toMatch(/>10k</);
    expect(svg).toMatch(/>21\.5k</);
  });

  it('escapes XML metacharacters in date labels', () => {
    const svg = renderLineChart([
      { date: '2026-06-20<script>', value: 1 },
      { date: '2026-06-22', value: 2 },
    ]);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
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
