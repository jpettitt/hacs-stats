import { escapeHtml } from './sanitize.js';

export interface LayoutProps {
  /** Document title — appears in <title> and browser tab. */
  title: string;
  /** What to put in the <h1>. Defaults to "hacs-stats". */
  pageHeading?: string;
  /** Active nav item key for highlighting. */
  navActive?: 'home' | 'categories' | 'search' | 'about';
  /** Optional inline search-box value to keep the query visible after submit. */
  searchValue?: string;
  /** Pre-rendered HTML body (escape your own inputs upstream!). */
  body: string;
}

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  font: 16px/1.5 system-ui, sans-serif;
  max-width: 72rem;
  margin: 2rem auto;
  padding: 0 1rem;
  color: #1a1a1a;
}
@media (prefers-color-scheme: dark) {
  body { background: #111; color: #eee; }
  .stat, table, .card, header { background: #1c1c1c; }
  th { background: #222; }
  a { color: #7ab8ff; }
  input { background: #1c1c1c; color: #eee; border-color: #444; }
}
header {
  display: flex; gap: 1rem; align-items: baseline; flex-wrap: wrap;
  margin-bottom: 1.5rem; padding: 0.75rem 1rem; background: #f3f4f6;
  border-radius: .5rem;
}
header h1 { margin: 0; font-size: 1.3rem; }
header h1 a { color: inherit; text-decoration: none; }
header nav { display: flex; gap: 1rem; flex: 1; }
header nav a { color: #555; text-decoration: none; padding: .25rem .5rem; border-radius: .25rem; }
header nav a:hover { background: rgba(128,128,128,.15); }
header nav a.active { background: rgba(128,128,128,.25); color: inherit; font-weight: 600; }
header form { display: flex; gap: .25rem; margin-left: auto; }
header input {
  font: inherit; padding: .25rem .5rem; border: 1px solid #ccc; border-radius: .25rem;
  width: 16rem; max-width: 100%;
}
header button {
  font: inherit; padding: .25rem .75rem; border: 1px solid #ccc;
  background: #fff; border-radius: .25rem; cursor: pointer;
}
@media (prefers-color-scheme: dark) {
  header button { background: #333; color: #eee; border-color: #555; }
}
.badge {
  display: inline-block; background: #fb923c; color: #1a1a1a;
  padding: .15rem .5rem; border-radius: .25rem;
  font-size: .8rem; font-weight: 600; vertical-align: middle;
}
.lead { color: #555; margin-top: 0; }
.muted { color: #777; }
.small { font-size: .85rem; }
section { margin: 2rem 0; }
section > h2 { margin-bottom: .5rem; }
.stat { margin: 1.5rem 0; padding: 1rem 1.25rem; background: #f3f4f6; border-radius: .5rem; }
.card { padding: 1rem 1.25rem; background: #fafafa; border-radius: .5rem; }
table {
  width: 100%; border-collapse: collapse;
  background: #fafafa; border-radius: .5rem; overflow: hidden;
}
th, td { padding: .5rem .75rem; text-align: left; border-bottom: 1px solid rgba(128,128,128,.2); }
th { background: #eee; font-size: .85rem; text-transform: uppercase; letter-spacing: .02em; }
tr:last-child td { border-bottom: none; }
td.kind { color: #666; font-size: .9rem; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.repo-name.unsafe { color: #c00; font-family: monospace; }
.chart { width: 100%; height: auto; max-height: 200px; }
.chart-line { stroke: #2563eb; stroke-width: 2; }
.chart-grid { stroke: rgba(128,128,128,.3); stroke-dasharray: 2 2; stroke-width: 1; }
.chart-axis { font-size: 10px; fill: #777; }
.chart-empty { font-size: 12px; fill: #999; }
@media (prefers-color-scheme: dark) { .chart-line { stroke: #7ab8ff; } }
footer { margin: 3rem 0 1rem; color: #888; font-size: .85rem; }
code { background: rgba(128,128,128,.15); padding: .1rem .3rem; border-radius: .25rem; }
`;

function navLink(
  href: string,
  label: string,
  key: NonNullable<LayoutProps['navActive']>,
  active?: LayoutProps['navActive'],
): string {
  return `<a href="${href}" class="${active === key ? 'active' : ''}">${escapeHtml(label)}</a>`;
}

export function renderLayout(props: LayoutProps): string {
  const heading = props.pageHeading ?? 'hacs-stats';
  const safeSearchVal = escapeHtml(props.searchValue ?? '');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(props.title)}</title>
  <style>${CSS}</style>
</head>
<body>
  <header>
    <h1><a href="/">${escapeHtml(heading)}</a> <span class="badge">unofficial</span></h1>
    <nav>
      ${navLink('/', 'Home', 'home', props.navActive)}
      ${navLink('/categories', 'Categories', 'categories', props.navActive)}
      ${navLink('/about', 'About', 'about', props.navActive)}
    </nav>
    <form action="/search" method="get" role="search">
      <input type="search" name="q" value="${safeSearchVal}" placeholder="Search repos…" autocomplete="off">
      <button type="submit">Search</button>
    </form>
  </header>

  ${props.body}

  <footer>
    Data sourced from public GitHub APIs. Downloads are a proxy for installs;
    Home Assistant does not phone home. Not affiliated with HACS.
    See the methodology on the <a href="/about">About</a> page.
  </footer>
</body>
</html>`;
}
