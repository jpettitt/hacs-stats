export interface LeaderRow {
  full_name: string;
  kind: string;
  stars: number;
  downloads_30d: number;
  star_delta_30d: number;
  top_version_30d: string | null;
}

export interface HomeProps {
  repoCount: number;
  topByStars: LeaderRow[];
  topByDownloads30d: LeaderRow[];
}

const KIND_LABEL: Record<string, string> = {
  integration: 'Integration',
  plugin: 'Plugin',
  theme: 'Theme',
  appdaemon: 'AppDaemon',
  netdaemon: 'NetDaemon',
  python_script: 'Python script',
  template: 'Template',
};

function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtDelta(n: number): string {
  if (n === 0) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${fmtInt(n)}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function repoLink(fullName: string): string {
  const safe = escapeHtml(fullName);
  return `<a href="https://github.com/${safe}" target="_blank" rel="noopener noreferrer">${safe}</a>`;
}

function leaderTable(
  rows: LeaderRow[],
  valueLabel: string,
  formatValue: (r: LeaderRow) => string,
): string {
  const body = rows
    .map(
      (r) => `
      <tr>
        <td>${repoLink(r.full_name)}</td>
        <td class="kind">${escapeHtml(KIND_LABEL[r.kind] ?? r.kind)}</td>
        <td class="num">${formatValue(r)}</td>
        <td class="num small">${fmtDelta(r.star_delta_30d)} ★ / 30d</td>
      </tr>`,
    )
    .join('');
  return `
    <table>
      <thead>
        <tr><th>Repo</th><th>Kind</th><th>${escapeHtml(valueLabel)}</th><th>Stars Δ30d</th></tr>
      </thead>
      <tbody>${body}</tbody>
    </table>`;
}

export function renderHome({ repoCount, topByStars, topByDownloads30d }: HomeProps): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>hacs-stats</title>
  <style>
    :root { color-scheme: light dark; }
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 64rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
    @media (prefers-color-scheme: dark) {
      body { background: #111; color: #eee; }
      .stat, table { background: #1c1c1c; }
      th { background: #222; }
      a { color: #7ab8ff; }
    }
    h1 { margin: 0 0 .25rem; }
    .lead { color: #555; margin-top: 0; }
    .badge { display: inline-block; background: #fb923c; color: #1a1a1a; padding: .15rem .5rem; border-radius: .25rem; font-size: .8rem; font-weight: 600; vertical-align: middle; }
    .stat { margin: 1.5rem 0; padding: 1rem 1.25rem; background: #f3f4f6; border-radius: .5rem; }
    section { margin: 2rem 0; }
    table { width: 100%; border-collapse: collapse; background: #fafafa; border-radius: .5rem; overflow: hidden; }
    th, td { padding: .5rem .75rem; text-align: left; border-bottom: 1px solid rgba(128,128,128,.2); }
    th { background: #eee; font-size: .85rem; text-transform: uppercase; letter-spacing: .02em; }
    tr:last-child td { border-bottom: none; }
    td.kind { color: #666; font-size: .9rem; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    td.small { font-size: .85rem; color: #777; }
    footer { margin: 3rem 0 1rem; color: #888; font-size: .85rem; }
    code { background: rgba(128,128,128,.15); padding: .1rem .3rem; border-radius: .25rem; }
  </style>
</head>
<body>
  <h1>hacs-stats <span class="badge">unofficial</span></h1>
  <p class="lead">Public download &amp; star stats for the Home Assistant Community Store.</p>

  <div class="stat">Tracking <strong>${fmtInt(repoCount)}</strong> repositories.</div>

  <section>
    <h2>Top by stars</h2>
    ${leaderTable(topByStars, 'Stars', (r) => fmtInt(r.stars))}
  </section>

  <section>
    <h2>Top by 30-day downloads</h2>
    <p class="lead small">
      Sum of HACS-asset download deltas over the last 30 days.
      Until we have ≥ 2 daily snapshots, every value here will be 0 — that's
      expected on day 1.
    </p>
    ${leaderTable(topByDownloads30d, '30d Δ downloads', (r) => fmtInt(r.downloads_30d))}
  </section>

  <footer>
    Data sourced from public GitHub APIs. Downloads are a proxy for installs;
    Home Assistant does not phone home. Not affiliated with HACS.
    See the methodology in <code>ARCHITECTURE.md</code>.
  </footer>
</body>
</html>`;
}
