import { leaders, openDb, repos, resolveDatabasePath } from '@hacs-stats/db';
import type { RepoKind } from '@hacs-stats/shared';
import { REPO_KINDS } from '@hacs-stats/shared';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { renderLayout } from './layout.js';
import { renderAboutPage } from './pages/about.js';
import { renderCategoriesIndex, renderCategoryPage } from './pages/category.js';
import { renderHome } from './pages/home.js';
import { renderRepoDetail } from './pages/repo.js';
import { renderSearchPage } from './pages/search.js';
import { isSafeRepoFullName } from './sanitize.js';

const DATABASE_PATH = resolveDatabasePath();
const PORT = Number(process.env.PORT ?? 3000);

// Web is strictly a reader — open read-only so we can never accidentally write
// from the user-facing process. The scraper holds the only RW handle.
const db = openDb({ path: DATABASE_PATH, mode: 'readonly' });

const VALID_KINDS = new Set<string>(REPO_KINDS);
const isRepoKind = (s: string): s is RepoKind => VALID_KINDS.has(s);

const app = new Hono();

// Defence-in-depth: even if a sanitisation bug ever lets a `<script>` slip
// into rendered HTML, this CSP prevents the browser from executing it.
// - default-src 'self'      — disallow off-domain scripts, fonts, iframes, etc.
// - style-src 'self' 'unsafe-inline' — page styles are inline today; tighten
//   once we move to an external stylesheet
// - img-src 'self' data: — small inline icons allowed
// - object-src 'none' — no <object>/<embed> plugins
// - base-uri 'none' — block <base> tag URL hijacks
// - frame-ancestors 'none' — clickjacking protection
const CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

app.use('*', async (c, next) => {
  await next();
  c.header('Content-Security-Policy', CSP);
  c.header('Referrer-Policy', 'no-referrer-when-downgrade');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Permissions-Policy', 'interest-cohort=()');
});

app.get('/health', (c) => c.json({ ok: true }));

app.get('/', (c) => {
  const body = renderHome({
    repoCount: repos.countRepos(db),
    topByStars: leaders.topByStars(db, 15),
    topByDownloads: leaders.topByLatestReleaseDownloads(db, 15),
    trendingByStars: leaders.trendingByStars(db, 15),
    newArrivals: leaders.newArrivals(db, 10),
    recentlyUpdated: leaders.recentlyUpdated(db, 10),
  });
  return c.html(
    renderLayout({
      title: 'hacs-stats — Home Assistant Community Store dashboard',
      navActive: 'home',
      body,
    }),
  );
});

app.get('/categories', (c) => {
  const body = renderCategoriesIndex({ totals: repos.categoryCounts(db) });
  return c.html(renderLayout({ title: 'Categories — hacs-stats', navActive: 'categories', body }));
});

app.get('/category/:kind', (c) => {
  const kind = c.req.param('kind');
  if (!isRepoKind(kind)) {
    return c.html(
      renderLayout({
        title: 'Unknown category — hacs-stats',
        navActive: 'categories',
        body: `<p>Unknown category. <a href="/categories">See the list</a>.</p>`,
      }),
      404,
    );
  }
  const page = parsePage(c.req.query('page'));
  const pageData = leaders.topByCategory(
    db,
    kind,
    CATEGORY_PAGE_SIZE,
    (page - 1) * CATEGORY_PAGE_SIZE,
  );
  const body = renderCategoryPage({
    kind,
    rows: pageData.rows,
    page,
    pageSize: CATEGORY_PAGE_SIZE,
    total: pageData.total,
  });
  return c.html(renderLayout({ title: `${kind} — hacs-stats`, navActive: 'categories', body }));
});

app.get('/r/:owner/:name', (c) => {
  // Hono decodes path params for us. We still revalidate via the same allow-list
  // used in `repoLink` — anything that wouldn't render as a link shouldn't load
  // as a page either.
  const owner = c.req.param('owner');
  const name = c.req.param('name');
  const fullName = `${owner}/${name}`;
  if (!isSafeRepoFullName(fullName)) {
    return c.html(
      renderLayout({
        title: 'Invalid repo — hacs-stats',
        body: `<p>That doesn't look like a valid <code>owner/repo</code> identifier.</p>`,
      }),
      400,
    );
  }
  const detail = leaders.repoDetailByFullName(db, fullName);
  if (!detail) {
    return c.html(
      renderLayout({
        title: 'Not found — hacs-stats',
        body: `<p>We don't have a repo called <code>${fullName}</code> in our catalogue.</p>`,
      }),
      404,
    );
  }
  const starsSeries = leaders
    .repoStarsTimeseries(db, detail.id, 30)
    .map((p) => ({ date: p.date, value: p.stars }));
  const releaseRows = leaders.releaseDownloadsForRepo(db, detail.id, 25);
  const body = renderRepoDetail({
    detail: {
      full_name: detail.full_name,
      hacs_name: detail.hacs_name,
      kind: detail.kind,
      description: detail.description,
      archived: detail.archived,
      hacs_filename: detail.hacs_filename,
      default_branch: detail.default_branch,
      first_seen_at: detail.first_seen_at,
      last_commit_at: detail.last_commit_at,
      last_scraped_at: detail.last_scraped_at,
      stars: detail.stars,
      star_delta_7d: detail.star_delta_7d,
      star_delta_30d: detail.star_delta_30d,
      downloads_30d: detail.downloads_30d,
      top_version_30d: detail.top_version_30d,
      latest_release_tag: detail.latest_release_tag,
      latest_release_downloads: detail.latest_release_downloads,
      latest_release_downloads_30d: detail.latest_release_downloads_30d,
      hot_release_tag_90d: detail.hot_release_tag_90d,
      hot_release_downloads_90d: detail.hot_release_downloads_90d,
    },
    starsSeries,
    releases: releaseRows,
  });
  const title = detail.hacs_name
    ? `${detail.hacs_name} (${fullName}) — hacs-stats`
    : `${fullName} — hacs-stats`;
  return c.html(renderLayout({ title, body }));
});

const SEARCH_PAGE_SIZE = 50;
const CATEGORY_PAGE_SIZE = 50;

function parsePage(raw: string | undefined): number {
  const n = Number(raw);
  // 1-based, capped at 10_000 so a malformed ?page=9e99 can't cause LIMIT N OFFSET
  // ridiculous-number computations. Anything fishy → page 1.
  if (!Number.isInteger(n) || n < 1 || n > 10_000) return 1;
  return n;
}

app.get('/search', (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 100);
  // sort / kind come from the user — validate against allowlists and fall
  // back to defaults rather than blindly passing strings into SQL.
  const sortRaw = c.req.query('sort') ?? '';
  const sort = (leaders.SEARCH_SORTS as readonly string[]).includes(sortRaw)
    ? (sortRaw as leaders.SearchSort)
    : 'name';
  const kindRaw = c.req.query('kind') ?? '';
  const kind = isRepoKind(kindRaw) ? kindRaw : undefined;
  const page = parsePage(c.req.query('page'));

  // Run a query when the user gave us q, kind, or non-default sort. Empty-
  // everything renders the bare filter bar (no point listing all 3.3k repos
  // by default — that's what /categories is for).
  const shouldQuery = q.length >= 2 || kind !== undefined;
  const result = shouldQuery
    ? leaders.searchRepos(db, {
        q,
        sort,
        ...(kind !== undefined ? { kind } : {}),
        limit: SEARCH_PAGE_SIZE,
        offset: (page - 1) * SEARCH_PAGE_SIZE,
      })
    : { rows: [], total: 0 };

  const body = renderSearchPage({
    query: q,
    sort,
    kind,
    allKinds: [...REPO_KINDS],
    hits: result.rows,
    page,
    pageSize: SEARCH_PAGE_SIZE,
    total: result.total,
  });
  const title = q
    ? `“${q}” — hacs-stats search`
    : kind
      ? `${kind} — hacs-stats search`
      : 'Search — hacs-stats';
  return c.html(
    renderLayout({
      title,
      navActive: 'search',
      searchValue: q,
      body,
    }),
  );
});

app.get('/about', (c) =>
  c.html(
    renderLayout({ title: 'About — hacs-stats', navActive: 'about', body: renderAboutPage() }),
  ),
);

// JSON API — surface enough for clients to render their own dashboards.
app.get('/api/stats/overview', (c) =>
  c.json({
    repos: repos.countRepos(db),
    topByStars: leaders.topByStars(db, 20),
    topByDownloads: leaders.topByLatestReleaseDownloads(db, 20),
  }),
);

app.get('/api/repo/:owner/:name', (c) => {
  const fullName = `${c.req.param('owner')}/${c.req.param('name')}`;
  if (!isSafeRepoFullName(fullName)) return c.json({ error: 'invalid name' }, 400);
  const detail = leaders.repoDetailByFullName(db, fullName);
  if (!detail) return c.json({ error: 'not found' }, 404);
  return c.json({
    repo: detail,
    starsSeries: leaders.repoStarsTimeseries(db, detail.id, 30),
    releases: leaders.releaseDownloadsForRepo(db, detail.id, 25),
  });
});

const server = serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  console.log(`hacs-stats web listening on http://localhost:${port}`);
  console.log(`  DB (read-only): ${DATABASE_PATH}`);
});

const shutdown = (signal: string) => {
  console.log(`\n${signal} received, shutting down…`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
