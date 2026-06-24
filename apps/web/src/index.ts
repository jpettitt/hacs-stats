import { discoveryQueue, leaders, openDb, repos, resolveDatabasePath } from '@hacs-stats/db';
import type { RepoKind } from '@hacs-stats/shared';
import { REPO_KINDS } from '@hacs-stats/shared';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { renderLayout } from './layout.js';
import { renderAboutPage } from './pages/about.js';
import { renderAdminPage } from './pages/admin.js';
import { renderCategoriesIndex, renderCategoryPage } from './pages/category.js';
import { renderHome } from './pages/home.js';
import { renderPendingPage, renderRemovedPage } from './pages/lifecycle.js';
import { renderRepoDetail } from './pages/repo.js';
import { renderSearchPage } from './pages/search.js';
import { renderSubmitPage } from './pages/submit.js';
import { isSafeRepoFullName } from './sanitize.js';

const DATABASE_PATH = resolveDatabasePath();
const PORT = Number(process.env.PORT ?? 3000);
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Two SQLite handles to the same WAL'd file:
//   db   — readonly, used by every public route. Belt-and-braces guard
//          against a sanitisation bug leading to an accidental write.
//   rwDb — read-write, ONLY used by /submit and /admin/*. Those routes
//          are the few places the web process legitimately writes
//          (discovery_queue inserts + status updates, repos accept).
const db = openDb({ path: DATABASE_PATH, mode: 'readonly' });
const rwDb = openDb({ path: DATABASE_PATH, mode: 'readwrite' });

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
      source: detail.source,
      state: detail.state,
      first_failure_at: detail.first_failure_at,
      is_fork: detail.is_fork,
      parent_full_name: detail.parent_full_name,
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
      searchValue: q,
      body,
    }),
  );
});

app.get('/pending', (c) => {
  const rows = leaders.pendingRepos(db, 200);
  return c.html(
    renderLayout({
      title: 'Pending repos — hacs-stats',
      body: renderPendingPage({ rows }),
    }),
  );
});

app.get('/removed', (c) => {
  const rows = leaders.removedRepos(db, 200);
  return c.html(
    renderLayout({
      title: 'Removed repos — hacs-stats',
      body: renderRemovedPage({ rows }),
    }),
  );
});

app.get('/about', (c) =>
  c.html(
    renderLayout({ title: 'About — hacs-stats', navActive: 'about', body: renderAboutPage() }),
  ),
);

// ---------------------------------------------------------------------------
// /submit — public submission form for custom HACS repos.
// ---------------------------------------------------------------------------

app.get('/submit', (c) =>
  c.html(
    renderLayout({
      title: 'Submit a repo — hacs-stats',
      body: renderSubmitPage({}),
    }),
  ),
);

const FAILURE_TEXT: Record<string, string> = {
  'invalid-name': 'That doesn’t look like a valid owner/repo identifier.',
  'repo-not-found': 'GitHub doesn’t know that repo. Check the spelling?',
  'private-or-removed': 'That repo is private or has been removed.',
  'no-hacs-json': 'No hacs.json at the repository root. HACS needs one.',
  'malformed-hacs-json': 'Found a hacs.json, but it wouldn’t parse.',
  'not-meaningful':
    'The hacs.json is missing every HACS-meaningful field. Likely a false positive.',
  'network-error': 'Couldn’t reach GitHub right now. Try again in a minute.',
};

app.post('/submit', async (c) => {
  const body = await c.req.parseBody();
  const repoRaw = typeof body.repo === 'string' ? body.repo.trim() : '';
  const kindRaw = typeof body.kind === 'string' ? body.kind : '';
  if (!repoRaw || !(REPO_KINDS as readonly string[]).includes(kindRaw)) {
    return c.html(
      renderLayout({
        title: 'Submit a repo — hacs-stats',
        body: renderSubmitPage({
          value: repoRaw,
          message: { kind: 'err', text: 'Both fields are required.' },
        }),
      }),
    );
  }
  const { validateSubmission } = await import('./submit-validation.js');
  const result = await validateSubmission(repoRaw, { token: GITHUB_TOKEN });
  if (!result.ok) {
    return c.html(
      renderLayout({
        title: 'Submit a repo — hacs-stats',
        body: renderSubmitPage({
          value: repoRaw,
          message: {
            kind: 'err',
            text: (result.failure && FAILURE_TEXT[result.failure]) || 'Validation failed.',
          },
        }),
      }),
    );
  }
  const url = `https://github.com/${repoRaw}`;
  const notes = `kind=${kindRaw}${result.notes ? `; ${result.notes}` : ''}`;
  discoveryQueue.enqueueDiscovery(rwDb, { url, source: 'user_submission', notes });
  return c.html(
    renderLayout({
      title: 'Submission received — hacs-stats',
      body: renderSubmitPage({
        message: {
          kind: 'ok',
          text: `Thanks — ${repoRaw} is queued for review and should appear in the catalogue after the next scrape if accepted.`,
        },
      }),
    }),
  );
});

// ---------------------------------------------------------------------------
// /admin — HTTP-basic-auth gated queue review.
// ---------------------------------------------------------------------------

function adminGate(c: { req: { header(name: string): string | undefined } }):
  | { ok: true }
  | { ok: false; status: 401 | 503 } {
  if (!ADMIN_USER || !ADMIN_PASS) return { ok: false, status: 503 };
  const auth = c.req.header('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('basic ')) return { ok: false, status: 401 };
  let decoded: string;
  try {
    decoded = atob(auth.slice(6));
  } catch {
    return { ok: false, status: 401 };
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return { ok: false, status: 401 };
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  if (user !== ADMIN_USER || pass !== ADMIN_PASS) return { ok: false, status: 401 };
  return { ok: true };
}

function adminChallenge(): Response {
  return new Response('admin auth required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="hacs-stats admin"' },
  });
}

app.get('/admin/queue', (c) => {
  const gate = adminGate(c);
  if (!gate.ok) {
    if (gate.status === 503) return c.text('admin endpoint not configured', 503);
    return adminChallenge();
  }
  const pending = discoveryQueue.listQueueByStatus(db, 'pending', 200);
  const totals = discoveryQueue.countQueueByStatus(db);
  const msg = c.req.query('msg');
  // Enrich each queue item with "related projects" — other repos in our
  // catalogue owned by the same GitHub owner. Helps the admin recognise
  // when the owner is a known prolific HACS contributor vs a brand-new face
  // (and notice when they've already submitted 12 cards in a batch).
  const enriched = pending.map((it) => {
    const m = /github\.com\/([A-Za-z0-9._-]+)\/[A-Za-z0-9._-]+$/.exec(it.url);
    const owner = m?.[1];
    const fullName = m ? it.url.replace(/^.*github\.com\//, '') : '';
    return {
      ...it,
      related: owner ? repos.listRepoIdentsByOwner(db, owner, fullName) : [],
    };
  });
  return c.html(
    renderLayout({
      title: 'Admin · queue — hacs-stats',
      body: renderAdminPage({
        pending: enriched,
        totals,
        ...(msg !== undefined ? { flash: msg } : {}),
      }),
    }),
  );
});

app.post('/admin/queue/decide', async (c) => {
  const gate = adminGate(c);
  if (!gate.ok) {
    if (gate.status === 503) return c.text('admin endpoint not configured', 503);
    return adminChallenge();
  }
  const body = await c.req.parseBody();
  const url = typeof body.url === 'string' ? body.url : '';
  const decision = typeof body.decision === 'string' ? body.decision : '';
  if (!url || (decision !== 'accept' && decision !== 'reject')) {
    return c.redirect('/admin/queue?msg=bad+request', 303);
  }
  if (decision === 'reject') {
    discoveryQueue.setQueueStatus(rwDb, url, 'rejected', null);
    return c.redirect('/admin/queue?msg=rejected', 303);
  }
  const m = /github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(url);
  if (!m || !m[1] || !m[2]) {
    return c.redirect('/admin/queue?msg=cant+parse+url', 303);
  }
  const owner = m[1];
  const name = m[2];
  const item = db.raw
    .prepare<[string], { source: string; notes: string | null }>(
      'SELECT source, notes FROM discovery_queue WHERE url = ?',
    )
    .get(url);
  const kindMatch = item?.notes ? /(?:^|;\s*)kind=([a-z_]+)/.exec(item.notes) : null;
  const kindFromNotes = kindMatch?.[1] ?? 'integration';
  if (!(REPO_KINDS as readonly string[]).includes(kindFromNotes)) {
    return c.redirect('/admin/queue?msg=invalid+kind+in+notes', 303);
  }
  const source = item?.source === 'user_submission' ? 'submitted' : 'discovered';
  repos.upsertRepo(rwDb, {
    owner,
    name,
    kind: kindFromNotes as RepoKind,
    source,
  });
  discoveryQueue.setQueueStatus(rwDb, url, 'accepted', null);
  return c.redirect(`/admin/queue?msg=accepted+${owner}/${name}`, 303);
});

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
    rwDb.close();
    process.exit(0);
  });
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
