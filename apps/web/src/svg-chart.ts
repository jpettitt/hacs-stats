/**
 * Tiny server-side SVG line-chart renderer, backed by d3-scale + d3-shape
 * for the math and tick placement. We assemble the SVG string by hand
 * (no jsdom) so this stays a pure server-render with no client JS.
 *
 * Why d3 modules and not the full d3?
 *   - We need scaleTime + scaleLinear + line generator + tick formatting
 *     and that's it. Tree-shaken submodules total ~25KB installed.
 *   - jsdom would let us use d3-axis directly but it's a 100MB install
 *     for ~50 lines of axis rendering we can do by hand.
 *   - Keeps the page free of client JS — no CSP wrangling, no FOUC, no
 *     "chart vanishes in `curl | less` or in print".
 */
import { extent } from 'd3-array';
import { scaleLinear, scaleTime } from 'd3-scale';
import { curveStepAfter, line as d3line } from 'd3-shape';
import { utcFormat } from 'd3-time-format';

export interface Point {
  /** ISO 8601 timestamp (e.g. '2026-06-22T00:00:00Z' or any string
   * Date.parse accepts). The chart treats x as continuous time; pass
   * the most precise timestamp the data source has rather than a
   * date-only string so the renderer doesn't have to guess a time zone. */
  date: string;
  /** y value — count of stars, downloads, whatever. */
  value: number;
}

export interface LineChartOptions {
  /** Total SVG size in viewBox units. Browsers scale it; pick what fits the column. */
  width?: number;
  height?: number;
  /** Padding inside the SVG so axis labels don't get clipped. */
  padding?: { top: number; right: number; bottom: number; left: number };
  /** ARIA description for screen readers + curl users. */
  ariaLabel?: string;
  /** CSS class for the <svg> root; pages can style fill/stroke from the layout. */
  className?: string;
  /**
   * When true (the default), the y-axis is pinned to 0 so the chart
   * tells the honest "this is the absolute magnitude" story. When the
   * caller has truncated older data (e.g. the 3-year display cap on
   * star history) the floor would be misleading — older data is
   * already off-screen and the visible range looks artificially small.
   * Pass false in that case to let the y-axis float to the data min.
   */
  zeroBase?: boolean;
}

const DEFAULTS = {
  width: 600,
  height: 280,
  padding: { top: 16, right: 16, bottom: 28, left: 48 },
};

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function emptyChart(width: number, height: number, msg: string, className: string): string {
  return `<svg viewBox="0 0 ${width} ${height}" class="${className}" role="img" aria-label="${escapeXml(
    msg,
  )}"><text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="chart-empty">${escapeXml(
    msg,
  )}</text></svg>`;
}

/** y-axis label format. K-suffix above 1000 so we don't smush "12345"
 * into the gutter. */
function fmtY(v: number): string {
  return Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v));
}

/** x-axis label format. d3-scaleTime gives us Date objects at each tick
 * position; we render them adaptively — year-only when the span is
 * many years (avoid "Jan 01 Jan 01 Jan 01" gibberish), otherwise
 * "MMM dd". */
function makeXFormatter(firstMs: number, lastMs: number): (d: Date) => string {
  const spanDays = (lastMs - firstMs) / 86_400_000;
  if (spanDays > 365 * 2) return utcFormat('%Y');
  if (spanDays > 90) return utcFormat('%b %Y');
  return utcFormat('%b %d');
}

export function renderLineChart(points: Point[], opts: LineChartOptions = {}): string {
  const width = opts.width ?? DEFAULTS.width;
  const height = opts.height ?? DEFAULTS.height;
  const pad = opts.padding ?? DEFAULTS.padding;
  const className = opts.className ?? 'chart';
  const ariaLabel = opts.ariaLabel ?? 'line chart';

  // Filter out points with unparseable date strings. The old chart used
  // the date as a literal label and would have rendered the garbage
  // string (with escaping); the new time-scaled chart routes everything
  // through Date objects, so bad input would produce NaN in the path.
  // Cleanest answer: drop the offending point entirely. Date objects
  // can't carry XSS payloads, so this is hardening rather than fixing a
  // live exploit.
  const valid = points.filter((p) => Number.isFinite(Date.parse(p.date)));
  if (valid.length === 0) return emptyChart(width, height, 'no data yet', className);
  if (valid.length === 1) {
    return emptyChart(width, height, 'one data point — chart needs 2+', className);
  }

  // Domain: time-based on x (real calendar distance between samples,
  // not array-index spacing — the earlier index-based renderer hid
  // bend points in any data with sparse samples). Y is "nice" — d3
  // rounds the domain to human-friendly bounds.
  // Pass full ISO timestamps through to Date (no normalisation here —
  // we already filtered unparseable strings above).
  const dates = valid.map((p) => new Date(p.date));
  const [d0, d1] = extent(dates) as [Date, Date];
  const values = valid.map((p) => p.value);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  // y-axis floor. Default: pinned to 0 — the honest "absolute magnitude"
  // story. Override (zeroBase=false) when the caller has clipped older
  // data and the visible range would otherwise look artificially small.
  const zeroBase = opts.zeroBase ?? true;
  const yDomainLow = zeroBase ? 0 : dataMin;
  const yDomainHigh = dataMax === yDomainLow ? yDomainLow + 1 : dataMax;

  const x = scaleTime()
    .domain([d0, d1])
    .range([pad.left, width - pad.right]);
  const y = scaleLinear()
    .domain([yDomainLow, yDomainHigh])
    .nice()
    .range([height - pad.bottom, pad.top]);

  // Step-after curve. Cumulative counts are mathematically step-shaped:
  // the value stays at N until the next event jumps it to N+1.
  // Linear interpolation between sparse samples implies "growth happened
  // evenly across this interval" which isn't what actually occurred.
  // The step shape also makes single-day jumps (e.g. a Hacker News post)
  // immediately visible as vertical risers instead of getting smoothed
  // into a gentle slope.
  const lineGen = d3line<Point>()
    .x((p) => x(new Date(p.date)))
    .y((p) => y(p.value))
    .curve(curveStepAfter);
  const path = lineGen(valid) ?? '';

  // Up to ~6 x-ticks and ~4 y-ticks. d3 picks human-friendly intervals
  // (months for sub-2y spans, years for longer; round counts for y).
  const xFormat = makeXFormatter(d0.getTime(), d1.getTime());
  const xTicks = x.ticks(6).map((d) => ({ pos: x(d), label: xFormat(d) }));
  const yTicks = y.ticks(4).map((v) => ({ pos: y(v), label: fmtY(v) }));

  // Plot bounds — used by the axis spines (solid lines along the left
  // and bottom of the plot area).
  const xLeft = pad.left;
  const xRight = width - pad.right;
  const yTop = pad.top;
  const yBottom = height - pad.bottom;

  // Render gridlines + axis labels manually — no jsdom needed.
  const yGrid = yTicks
    .map(
      (t) => `<line x1="${xLeft}" x2="${xRight}" y1="${t.pos}" y2="${t.pos}" class="chart-grid"/>`,
    )
    .join('');
  const yLabels = yTicks
    .map(
      (t) =>
        `<text x="${xLeft - 6}" y="${t.pos + 4}" text-anchor="end" class="chart-axis">${escapeXml(t.label)}</text>`,
    )
    .join('');
  // x-axis tick marks: short vertical strokes from the axis spine into
  // the plot area. Reads "data point at this position" without being
  // as loud as a full vertical gridline.
  const xTickMarks = xTicks
    .map(
      (t) =>
        `<line x1="${t.pos}" x2="${t.pos}" y1="${yBottom}" y2="${yBottom + 4}" class="chart-axis-tick"/>`,
    )
    .join('');
  const xLabels = xTicks
    .map(
      (t) =>
        `<text x="${t.pos}" y="${height - 8}" text-anchor="middle" class="chart-axis">${escapeXml(t.label)}</text>`,
    )
    .join('');
  // Spines: solid lines along the left (y) and bottom (x) edges of the
  // plot area. Visually anchor the chart so the data isn't floating
  // against the gridlines.
  const spines = `<line x1="${xLeft}" x2="${xLeft}" y1="${yTop}" y2="${yBottom}" class="chart-axis-line"/><line x1="${xLeft}" x2="${xRight}" y1="${yBottom}" y2="${yBottom}" class="chart-axis-line"/>`;

  return `<svg viewBox="0 0 ${width} ${height}" class="${className}" role="img" aria-label="${escapeXml(
    ariaLabel,
  )}">
  ${yGrid}
  ${spines}
  ${xTickMarks}
  ${yLabels}
  ${xLabels}
  <path d="${path}" class="chart-line" fill="none"/>
</svg>`;
}
