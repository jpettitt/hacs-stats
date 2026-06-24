/**
 * Tiny server-side SVG line-chart renderer.
 *
 * Why not Chart.js / uPlot / Recharts? Server-rendered SVG means:
 *   - Zero client JS → CSP stays strict (no `unsafe-inline` for scripts).
 *   - Page payload is one HTTP response; no FOUC, no client data fetch.
 *   - Works in print, in feed readers, in `curl | less`.
 *   - The numbers don't change after page load anyway (we refresh daily).
 *
 * Limited to line charts because that's all the dashboard needs right now.
 * Add bars / areas the day we do.
 */

export interface Point {
  /** ISO date YYYY-MM-DD. Used as the x label and for ordering. */
  date: string;
  /** y value — count of stars, downloads, whatever. */
  value: number;
}

export interface LineChartOptions {
  /** Total SVG size in viewBox units. The browser scales it; pick what fits the column. */
  width?: number;
  height?: number;
  /** Padding inside the SVG so axis labels don't get clipped. */
  padding?: { top: number; right: number; bottom: number; left: number };
  /** ARIA description for screen readers + curl users. */
  ariaLabel?: string;
  /** CSS class for the <svg> root; pages can style fill/stroke from the layout. */
  className?: string;
}

const DEFAULTS = {
  width: 600,
  height: 200,
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

/**
 * Render a single-series line chart with min/max gridlines and one
 * label per chart on each axis. Deliberately minimal — readable in dark
 * mode and on print, no interactivity.
 */
export function renderLineChart(points: Point[], opts: LineChartOptions = {}): string {
  const width = opts.width ?? DEFAULTS.width;
  const height = opts.height ?? DEFAULTS.height;
  const pad = opts.padding ?? DEFAULTS.padding;
  const className = opts.className ?? 'chart';
  const ariaLabel = opts.ariaLabel ?? 'line chart';

  if (points.length === 0) return emptyChart(width, height, 'no data yet', className);
  if (points.length === 1) {
    return emptyChart(width, height, 'one data point — chart needs 2+', className);
  }

  // Scales. y is "nice" — pinned to 0 unless every value is far above zero,
  // in which case we let it float to keep the visible range readable.
  const values = points.map((p) => p.value);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const yMin = dataMin > 0 && dataMax - dataMin > dataMin * 0.1 ? dataMin : 0;
  const yMax = dataMax === yMin ? yMin + 1 : dataMax;

  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const xAt = (i: number) =>
    pad.left + (points.length === 1 ? plotW / 2 : (i * plotW) / (points.length - 1));
  const yAt = (v: number) => pad.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`)
    .join(' ');

  const fmtY = (v: number) =>
    Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v));
  const firstPoint = points[0];
  const lastPoint = points.at(-1);
  if (!firstPoint || !lastPoint) {
    // Unreachable given the points.length checks above, but TS doesn't know.
    return emptyChart(width, height, 'no data yet', className);
  }
  const firstDate = firstPoint.date;
  const lastDate = lastPoint.date;
  const yMinLabel = escapeXml(fmtY(yMin));
  const yMaxLabel = escapeXml(fmtY(yMax));

  return `<svg viewBox="0 0 ${width} ${height}" class="${className}" role="img" aria-label="${escapeXml(
    ariaLabel,
  )}">
  <!-- gridlines -->
  <line x1="${pad.left}" x2="${width - pad.right}" y1="${yAt(yMax)}" y2="${yAt(
    yMax,
  )}" class="chart-grid"/>
  <line x1="${pad.left}" x2="${width - pad.right}" y1="${yAt(yMin)}" y2="${yAt(
    yMin,
  )}" class="chart-grid"/>
  <!-- y-axis labels -->
  <text x="${pad.left - 6}" y="${yAt(yMax) + 4}" text-anchor="end" class="chart-axis">${yMaxLabel}</text>
  <text x="${pad.left - 6}" y="${yAt(yMin) + 4}" text-anchor="end" class="chart-axis">${yMinLabel}</text>
  <!-- x-axis labels (first + last only) -->
  <text x="${pad.left}" y="${height - 8}" text-anchor="start" class="chart-axis">${escapeXml(firstDate)}</text>
  <text x="${width - pad.right}" y="${height - 8}" text-anchor="end" class="chart-axis">${escapeXml(lastDate)}</text>
  <!-- line -->
  <path d="${path}" class="chart-line" fill="none"/>
</svg>`;
}
