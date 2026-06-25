import { escapeHtml } from './sanitize.js';

export interface LayoutProps {
  /** Document title — appears in <title> and browser tab. */
  title: string;
  /** What to put in the <h1>. Defaults to "hacs-stats". */
  pageHeading?: string;
  /** Active nav item key for highlighting. */
  navActive?: 'home' | 'categories' | 'submit' | 'about';
  /** Optional inline search-box value to keep the query visible after submit. */
  searchValue?: string;
  /** Pre-rendered HTML body (escape your own inputs upstream!). */
  body: string;
}

/**
 * Color palette is derived from Tailwind's `slate` (neutral) + `blue` (accent)
 * + `amber` (badge) scales. Every text/background pair is chosen to clear
 * WCAG AA at the chosen sizes:
 *
 *   light: text #0f172a on #ffffff       →  16.1:1
 *          muted text #475569 on white   →   7.6:1
 *          muted text #475569 on #f8fafc →   7.4:1
 *   dark : text #f1f5f9 on #0f172a       →  14.6:1
 *          muted #94a3b8 on #0f172a      →   5.7:1
 *          muted #94a3b8 on #1e293b      →   5.4:1
 *
 * Borders and dividers are intentionally low-contrast — they're decoration,
 * not text. The accent blue (links + chart lines) was picked to clear 4.5:1
 * on both backgrounds (#1d4ed8 on light, #93c5fd on dark).
 *
 * All colors live in CSS custom properties so the dark-mode block is a small
 * diff over the light-mode defaults.
 */
const CSS = `
:root {
  color-scheme: light dark;
  --bg:            #ffffff;
  --bg-elev:       #f8fafc;
  --bg-elev-2:     #f1f5f9;
  --text:          #0f172a;
  --text-muted:    #475569;
  --text-dimmer:   #64748b;
  --border:        #e2e8f0;
  --border-strong: #cbd5e1;
  --accent:        #1d4ed8;
  --accent-hover:  #1e40af;
  --accent-bg:     #eff6ff;
  --badge-bg:      #d97706;
  --badge-text:    #ffffff;
  --danger:        #b91c1c;
  --warn-bg:       #fef3c7;
  --warn-text:     #78350f;
  --chart-line:    #1d4ed8;
  --chart-grid:    #cbd5e1;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg:            #0f172a;
    --bg-elev:       #1e293b;
    --bg-elev-2:     #334155;
    --text:          #f1f5f9;
    --text-muted:    #cbd5e1;
    --text-dimmer:   #94a3b8;
    --border:        #334155;
    --border-strong: #475569;
    --accent:        #93c5fd;
    --accent-hover:  #bfdbfe;
    --accent-bg:     #1e3a8a;
    --badge-bg:      #f59e0b;
    --badge-text:    #1a1300;
    --danger:        #f87171;
    --warn-bg:       #422006;
    --warn-text:     #fde68a;
    --chart-line:    #93c5fd;
    --chart-grid:    #475569;
  }
}

* { box-sizing: border-box; }

html, body { background: var(--bg); }
body {
  font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  max-width: 72rem;
  margin: 0 auto;
  padding: 1.5rem 1rem 3rem;
  color: var(--text);
}

a {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-thickness: 1px;
}
a:hover { color: var(--accent-hover); }

h1, h2, h3 { line-height: 1.25; color: var(--text); }
h1 { margin: 0; font-size: 1.4rem; font-weight: 700; }
h2 { font-size: 1.25rem; font-weight: 600; margin: 0 0 .5rem; }
h3 { font-size: 1rem; font-weight: 600; margin: 1.25rem 0 .25rem; }

/* ---------- top bar -------------------------------------------------- */
header.topbar {
  display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;
  margin-bottom: 1.75rem; padding: .75rem 1rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: .5rem;
}
header.topbar .brand a {
  color: var(--text);
  text-decoration: none;
  font-weight: 700;
}
header.topbar nav {
  display: flex; gap: .25rem; flex: 1; flex-wrap: wrap;
}
header.topbar nav a {
  color: var(--text-muted);
  text-decoration: none;
  padding: .35rem .7rem;
  border-radius: .35rem;
  font-weight: 500;
}
header.topbar nav a:hover { background: var(--bg-elev-2); color: var(--text); }
header.topbar nav a.active {
  background: var(--accent-bg);
  color: var(--accent);
  font-weight: 600;
}
header.topbar form { display: flex; gap: .35rem; margin-left: auto; }
header.topbar input {
  font: inherit; padding: .4rem .6rem;
  border: 1px solid var(--border-strong); border-radius: .35rem;
  background: var(--bg); color: var(--text);
  width: 16rem; max-width: 100%;
}
header.topbar input:focus {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
  border-color: var(--accent);
}
header.topbar button {
  font: inherit; padding: .4rem .85rem;
  border: 1px solid var(--border-strong); border-radius: .35rem;
  background: var(--bg-elev-2); color: var(--text);
  cursor: pointer; font-weight: 500;
}
header.topbar button:hover { background: var(--bg-elev); }

/* ---------- badges --------------------------------------------------- */
.badge {
  display: inline-block;
  background: var(--badge-bg); color: var(--badge-text);
  padding: .1rem .55rem; border-radius: .35rem;
  font-size: .75rem; font-weight: 700;
  vertical-align: middle; letter-spacing: .02em;
  text-transform: uppercase;
}
.badge-muted { background: var(--bg-elev-2); color: var(--text-muted); }

/* ---------- structure ------------------------------------------------ */
section { margin: 2.25rem 0; }
section > h2 { margin-bottom: .75rem; }
.lead { color: var(--text-muted); margin-top: 0; }
.muted { color: var(--text-muted); }
.small { font-size: .85rem; }
.subtitle { margin: .25rem 0 1rem; }

.stat {
  margin: 1.5rem 0; padding: 1rem 1.25rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: .5rem;
}
.stat strong { color: var(--text); }

.card {
  padding: 1rem 1.25rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: .5rem;
}

.cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: .75rem;
}
.cards-grid a.card { color: inherit; text-decoration: none; transition: border-color .15s; display: block; }
.cards-grid a.card:hover { border-color: var(--accent); }
.cards-grid .card strong { font-size: 1.6rem; display: block; line-height: 1.1; }
.cards-grid .card span { color: var(--text-muted); font-size: .9rem; }

/* ---------- stat tile row (repo detail) ----------------------------- */
.stats-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 1rem;
}
.stat-tile strong { display: block; font-size: 1.6rem; line-height: 1.1; color: var(--text); }
.stat-tile span { display: block; margin-top: .15rem; }

/* ---------- a11y ---------------------------------------------------- */
.visually-hidden {
  position: absolute; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}

/* ---------- tags (source / fork / archived) ------------------------- */
.tag {
  display: inline-block;
  padding: .05rem .4rem;
  border-radius: .25rem;
  font-size: .7rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: .04em;
  vertical-align: middle;
  border: 1px solid transparent;
}
.tag-discovered { color: var(--accent); border-color: var(--accent); }
.tag-submitted  { color: #047857; border-color: #047857; }
.tag-fork       { color: #92400e; border-color: #92400e; }
.tag-archived   { color: var(--text-dimmer); border-color: var(--text-dimmer); }
/* Pending = solid fill in the accent colour, NOT a muted outline — this is
   the most important context ("the numbers next to me aren't real yet")
   and should be impossible to miss. */
.tag-pending    { background: var(--accent); color: white; border-color: var(--accent); }
@media (prefers-color-scheme: dark) {
  .tag-submitted { color: #34d399; border-color: #34d399; }
  .tag-fork      { color: #fbbf24; border-color: #fbbf24; }
  .tag-pending   { color: #0f172a; }
}

/* ---------- admin queue: related projects block --------------------- */
.related {
  margin-top: .35rem;
  padding: .35rem .55rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: .35rem;
  line-height: 1.5;
}
.related a { color: var(--accent); text-decoration: none; }
.related a:hover { text-decoration: underline; }

/* ---------- repo detail: 'other repos from this owner' ------------- */
.related-list {
  margin: .5rem 0; padding-left: 1.25rem; columns: 2; column-gap: 2rem;
}
.related-list li { break-inside: avoid; margin-bottom: .15rem; }

/* ---------- admin queue: status tabs ------------------------------- */
.tabs {
  display: flex; gap: .25rem; margin: 0.75rem 0 1rem;
  border-bottom: 1px solid var(--border);
}
.tab {
  padding: .45rem .85rem;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: .35rem .35rem 0 0;
  color: var(--text-muted);
  text-decoration: none;
  font-weight: 500;
}
.tab:hover { color: var(--text); }
.tab-active {
  background: var(--bg-elev);
  border-color: var(--border);
  color: var(--text);
  /* visually merge with the table below */
  margin-bottom: -1px;
  border-bottom: 1px solid var(--bg-elev);
}

/* ---------- sortable column headers (admin queue) ------------------ */
th.sort-active { color: var(--accent); }
th a { color: inherit; text-decoration: none; }
th a:hover { text-decoration: underline; }

/* ---------- lifecycle banners (pending / offline / removed) --------- */
.banner {
  margin: 1.25rem 0; padding: .85rem 1.1rem;
  border-radius: .5rem;
  border-left: 4px solid var(--accent);
  background: var(--bg-elev);
  display: flex; gap: .75rem; flex-wrap: wrap; align-items: baseline;
}
.banner strong { color: var(--text); }
.banner span   { color: var(--text-muted); font-size: .95rem; flex: 1; min-width: 14rem; }
.banner-info { border-left-color: var(--accent); }
.banner-warn { border-left-color: var(--warn-text); }
.banner-err  { border-left-color: var(--danger); }

/* ---------- pagination ---------------------------------------------- */
.pagination {
  display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;
  margin: 1rem 0;
  padding: .5rem .75rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: .35rem;
}
.pagination .page-info { flex: 1; text-align: center; }
.pagination a.page-link,
.pagination .page-disabled,
.pagination .page-current {
  padding: .25rem .6rem; border-radius: .25rem;
  border: 1px solid var(--border-strong);
  text-decoration: none;
  font-weight: 500;
}
.pagination a.page-link { background: var(--bg); color: var(--accent); }
.pagination a.page-link:hover { background: var(--accent-bg); }
.pagination .page-disabled { color: var(--text-dimmer); background: var(--bg); cursor: not-allowed; }
.pagination .page-current { background: var(--accent); color: white; }

/* ---------- submit form (stacked, generously sized) ----------------- */
.submit-form {
  display: grid; gap: 1rem;
  max-width: 36rem;
  margin: 1.5rem 0;
  padding: 1.25rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: .5rem;
}
.submit-field { display: grid; gap: .35rem; }
.submit-field label { font-size: .9rem; font-weight: 600; color: var(--text); }
.submit-form input[type="text"],
.submit-form select {
  font: inherit; padding: .65rem .85rem; font-size: 1.05rem;
  border: 1px solid var(--border-strong); border-radius: .4rem;
  background: var(--bg); color: var(--text);
  width: 100%;
}
.submit-form input:focus,
.submit-form select:focus {
  outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent);
}
.submit-form button {
  justify-self: start;
  font: inherit; padding: .6rem 1.25rem; font-size: 1.05rem; font-weight: 600;
  border: 1px solid var(--accent); border-radius: .4rem;
  background: var(--accent); color: white; cursor: pointer;
}
.submit-form button:hover { background: var(--accent-hover); border-color: var(--accent-hover); }

/* ---------- filter bar (search results) ----------------------------- */
.filter-bar {
  display: flex; gap: .5rem; flex-wrap: wrap; align-items: center;
  padding: .75rem 1rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: .5rem;
}
.filter-bar input[type="search"] {
  flex: 1 1 16rem;
  font: inherit; padding: .4rem .6rem;
  border: 1px solid var(--border-strong); border-radius: .35rem;
  background: var(--bg); color: var(--text);
}
.filter-bar select {
  font: inherit; padding: .4rem .55rem;
  border: 1px solid var(--border-strong); border-radius: .35rem;
  background: var(--bg); color: var(--text);
  min-width: 9rem;
}
.filter-bar button {
  font: inherit; padding: .4rem .85rem;
  border: 1px solid var(--border-strong); border-radius: .35rem;
  background: var(--accent); color: white; cursor: pointer; font-weight: 600;
}
.filter-bar button:hover { background: var(--accent-hover); }
.filter-bar input:focus, .filter-bar select:focus {
  outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent);
}

/* ---------- tables --------------------------------------------------- */
table {
  width: 100%; border-collapse: collapse;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: .5rem;
  overflow: hidden;
}
th, td {
  padding: .55rem .75rem; text-align: left;
  border-bottom: 1px solid var(--border);
}
th {
  background: var(--bg-elev-2);
  color: var(--text-muted);
  font-size: .75rem;
  text-transform: uppercase;
  letter-spacing: .04em;
  font-weight: 600;
}
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--bg-elev-2); }
td.kind { color: var(--text-muted); font-size: .9rem; white-space: nowrap; }
td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
/* Description column wraps but never grows beyond ~40ch so the repo name
   column doesn't get squashed on wide leaderboards. */
.desc-col { max-width: 32rem; }
table { table-layout: auto; }

/* ---------- repo name --------------------------------------------- */
a.repo-name { text-decoration: none; color: var(--text); }
a.repo-name:hover .repo-display { text-decoration: underline; }
a.repo-name .repo-display { color: var(--text); font-weight: 600; }
a.repo-name .repo-slug { display: inline-block; margin-left: .25rem; }
.repo-name.unsafe { color: var(--danger); font-family: ui-monospace, "SF Mono", Menlo, monospace; }

/* ---------- repo detail header -------------------------------------- */
.repo-title { margin-bottom: 0; }
.repo-title .badge { margin-left: .5rem; vertical-align: 0.15em; }

/* ---------- chart ---------------------------------------------------- */
.chart { width: 100%; height: auto; max-height: 220px; }
.chart-line { stroke: var(--chart-line); stroke-width: 2; fill: none; }
.chart-grid { stroke: var(--chart-grid); stroke-dasharray: 2 3; stroke-width: 1; }
.chart-axis { font-size: 11px; fill: var(--text-dimmer); }
.chart-empty { font-size: 12px; fill: var(--text-dimmer); }

/* ---------- footer / inline code ------------------------------------ */
footer.page {
  margin: 3rem 0 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
  color: var(--text-dimmer);
  font-size: .85rem;
}
code {
  background: var(--bg-elev-2);
  color: var(--text);
  padding: .1rem .35rem;
  border-radius: .25rem;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: .9em;
}
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
  <header class="topbar">
    <h1 class="brand"><a href="/">${escapeHtml(heading)}</a> <span class="badge">unofficial</span></h1>
    <nav>
      ${navLink('/', 'Home', 'home', props.navActive)}
      ${navLink('/categories', 'Categories', 'categories', props.navActive)}
      ${navLink('/submit', 'Submit', 'submit', props.navActive)}
      ${navLink('/about', 'About', 'about', props.navActive)}
    </nav>
    <form action="/search" method="get" role="search">
      <label class="visually-hidden" for="searchq">Search repositories</label>
      <input id="searchq" type="search" name="q" value="${safeSearchVal}" placeholder="Search repos…" autocomplete="off">
      <button type="submit">Search</button>
    </form>
  </header>

  <main>
  ${props.body}
  </main>

  <footer class="page">
    Data sourced from public GitHub APIs. Downloads are a proxy for installs;
    Home Assistant does not phone home. Not affiliated with HACS.
    See the methodology on the <a href="/about">About</a> page.
  </footer>
</body>
</html>`;
}
