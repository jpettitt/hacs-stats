import {
  discoveryQueue,
  leaders,
  openDb,
  repos,
  resolveDatabasePath,
  starHistory,
} from '@hacs-stats/db';
import type { RepoKind } from '@hacs-stats/shared';
import { REPO_KINDS } from '@hacs-stats/shared';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { ADMIN_QUEUE_JS } from './admin-queue-script.js';
import { FAVICON_LIVE } from './favicon.js';
import { notModifiedSince, parseTimestamp, setCacheHeaders } from './http-cache.js';
import { renderLayout } from './layout.js';
import { renderAboutPage } from './pages/about.js';
import { renderAdminPage } from './pages/admin.js';
import { renderCategoriesIndex } from './pages/category.js';
import { renderHome } from './pages/home.js';
import { renderPendingPage, renderRemovedPage } from './pages/lifecycle.js';
import { renderOwnerPage } from './pages/owner.js';
import { renderPrivacyPage } from './pages/privacy.js';
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

/** Days of star-history the chart shows. Data older than this is kept
 * in the DB (the scraper accumulates forever) but trimmed from the
 * rendered curve so the chart's x-axis stays legible. */
const STAR_HISTORY_DISPLAY_DAYS = 365 * 3;

interface StarsSeries {
  points: Array<{ date: string; value: number }>;
  /** True when older data was clipped off by the 3-year display rule.
   * Tells the chart to float the y-axis instead of pinning to 0 (which
   * would otherwise compress the visible range against the top). */
  truncated: boolean;
}

/**
 * Star series for one repo's detail page. Prefers the
 * repo_star_history table (full curve back to repo creation, fed by the
 * scraper's step 2.5), and falls back to the last 30 daily snapshots
 * when history hasn't been built yet (newly-added repos before their
 * first star-history scrape). Trims to the last 3y for display.
 *
 * Returns ISO timestamps (not bare YYYY-MM-DD) so downstream Date()
 * parsing isn't ambiguous about time-zone.
 */
function starsSeriesForRepo(repoId: number): StarsSeries {
  const todayDay = new Date().toISOString().slice(0, 10);

  /** Add a synthetic data point at today's date carrying the latest
   * cumulative value, so the chart's right edge is "now" rather than
   * the day of the last star event. A repo that hasn't picked up a
   * star in two weeks should show a visible flat run at the end of
   * the curve, not a chart that stops two weeks ago. No-op when the
   * series already has a point on today. */
  const extendToToday = (points: Array<{ date: string; value: number }>) => {
    if (points.length === 0) return;
    const last = points[points.length - 1];
    if (!last) return;
    if (last.date.startsWith(todayDay)) return;
    points.push({ date: `${todayDay}T00:00:00Z`, value: last.value });
  };

  const history = starHistory.repoStarHistory(db, repoId);
  if (history.length > 0) {
    const cutoffDay = new Date(Date.now() - STAR_HISTORY_DISPLAY_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const trimmed = history.filter((p) => p.day >= cutoffDay);
    const truncated = trimmed.length < history.length;
    const points = trimmed.map((p) => ({
      date: `${p.day}T00:00:00Z`,
      value: p.cumulative,
    }));
    // Prepend a zero anchor one day before the first observed star so
    // the chart visually starts at 0 and rises to the first data point,
    // instead of starting at whatever the first day's count was. Only
    // when the curve isn't truncated by the 3y rule — otherwise the
    // "first" point is just the oldest visible one (not the repo's
    // first star ever) and a zero anchor there would be a lie.
    if (!truncated && points.length > 0 && points[0]) {
      const firstDay = points[0].date.slice(0, 10);
      const dayBefore = new Date(Date.parse(`${firstDay}T00:00:00Z`) - 86_400_000)
        .toISOString()
        .slice(0, 10);
      points.unshift({ date: `${dayBefore}T00:00:00Z`, value: 0 });
    }
    extendToToday(points);
    return { points, truncated };
  }
  const points = leaders
    .repoStarsTimeseries(db, repoId, 30)
    .map((p) => ({ date: `${p.date}T00:00:00Z`, value: p.stars }));
  extendToToday(points);
  return { points, truncated: false };
}

const app = new Hono();

// Defence-in-depth: even if a sanitisation bug ever lets a `<script>` slip
// into rendered HTML, this CSP prevents the browser from executing it.
// - default-src 'self'      — disallow off-domain scripts, fonts, iframes, etc.
// - script-src — allow self + Google Tag Manager (the gtag loader lives at
//   googletagmanager.com) + a single SHA-256 hash for the inline gtag-
//   config snippet in layout.ts. The hash binds to the EXACT bytes in
//   GTAG_INLINE; change either side and the script silently stops
//   executing (analytics breaks, page still renders). Recompute with:
//     printf '%s' "<inline script body>" | openssl dgst -sha256 -binary | openssl base64
// - connect-src — gtag posts beacons to *.google-analytics.com etc.
// - img-src 'self' data: — small inline icons + the GA pixel.
// - style-src 'self' 'unsafe-inline' — page styles are inline today; tighten
//   once we move to an external stylesheet
// - object-src 'none' — no <object>/<embed> plugins
// - base-uri 'none' — block <base> tag URL hijacks
// - frame-ancestors 'none' — clickjacking protection
const GTAG_INLINE_SHA256 = 'sha256-oMZayXzesR1hateqaVS8Wx5q7j/dmUGohqU6xQnCkHA=';
const CSP = [
  "default-src 'self'",
  `script-src 'self' https://www.googletagmanager.com '${GTAG_INLINE_SHA256}'`,
  "connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com",
  "img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com",
  "style-src 'self' 'unsafe-inline'",
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

// Favicon — inline SVG, cached for a day. Lives in apps/web/src/favicon.ts.
app.get('/favicon.svg', (c) => {
  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'public, max-age=86400');
  return c.body(FAVICON_LIVE);
});

// Small progressive-enhancement script for /admin/queue — intercepts
// Accept/Reject submits to drop the row in place instead of reloading
// the page. Served from /static/ so script-src 'self' covers it
// without another CSP hash.
app.get('/static/admin-queue.js', (c) => {
  c.header('Content-Type', 'application/javascript');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(ADMIN_QUEUE_JS);
});

/**
 * Catalogue-wide Last-Modified — the most recent scrape day. The whole
 * dashboard turns over on the same daily cadence (scrape at 04:00 UTC
 * writes the full snapshot pass), so every listing/category/home view
 * shares this one timestamp. Cloudflare caches at the edge; once
 * tomorrow's scrape lands the cached body becomes stale and CF
 * revalidates with us via If-Modified-Since.
 */
function catalogueLastModified(): Date {
  return parseTimestamp(`${leaders.dataAsOfDate(db)}T04:00:00Z`);
}

app.get('/', (c) => {
  const lm = catalogueLastModified();
  if (notModifiedSince(c, lm)) return c.body(null, 304);
  setCacheHeaders(c, lm);
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
  const lm = catalogueLastModified();
  if (notModifiedSince(c, lm)) return c.body(null, 304);
  setCacheHeaders(c, lm);
  const body = renderCategoriesIndex({ totals: repos.categoryCounts(db) });
  return c.html(renderLayout({ title: 'Categories — hacs-stats', navActive: 'categories', body }));
});

// /category/:kind is now an alias for /search?kind=…&sort=stars. There's
// only one listing render path (the search page) so the category view
// stays consistent with every other "show me a filtered list" entry
// point. 302 (not 301) keeps bookmarks pointing at the alias if we ever
// want to revive a dedicated category renderer.
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
  return c.redirect(`/search?kind=${encodeURIComponent(kind)}&sort=stars`, 302);
});

app.get('/owner/:owner', (c) => {
  const owner = c.req.param('owner');
  // Same allow-list as repo names: GitHub usernames/orgs are alnum + - / _
  // / dot. We're stricter than GitHub's actual rules (which permit unicode)
  // because the URL space is ours to constrain — any owner we'd catalogue
  // must have a valid GitHub handle anyway.
  if (!/^[A-Za-z0-9._-]{1,39}$/.test(owner)) {
    return c.html(
      renderLayout({
        title: 'Invalid owner — hacs-stats',
        body: `<p>That doesn't look like a valid GitHub owner.</p>`,
      }),
      400,
    );
  }
  const lm = catalogueLastModified();
  if (notModifiedSince(c, lm)) return c.body(null, 304);
  setCacheHeaders(c, lm);
  const ownerRepos = leaders.reposByOwner(db, owner, 200);
  return c.html(
    renderLayout({
      title: `${owner} — hacs-stats`,
      body: renderOwnerPage({ owner, repos: ownerRepos }),
    }),
  );
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
  // ?profile=1 emits an X-Timing header with per-section ms so we can
  // pinpoint slow stages on the prod DB without sprinkling console.log.
  // Cheap when off (profile is undefined). Stays opt-in so normal page
  // loads don't pay the high-resolution clock cost.
  const profile = c.req.query('profile') === '1';
  const timings: Record<string, number> = {};
  const time = <T>(label: string, fn: () => T): T => {
    if (!profile) return fn();
    const t0 = performance.now();
    const out = fn();
    timings[label] = Math.round((performance.now() - t0) * 100) / 100;
    return out;
  };

  const detail = time('repoDetail', () => leaders.repoDetailByFullName(db, fullName));
  if (!detail) {
    return c.html(
      renderLayout({
        title: 'Not found — hacs-stats',
        body: `<p>We don't have a repo called <code>${fullName}</code> in our catalogue.</p>`,
      }),
      404,
    );
  }
  // Per-repo Last-Modified: the repo's own last_scraped_at when present,
  // else the catalogue-wide cutover. Pending/never-scraped rows fall
  // back to the catalogue date so they still get cached.
  const lm = parseTimestamp(detail.last_scraped_at ?? `${leaders.dataAsOfDate(db)}T04:00:00Z`);
  if (notModifiedSince(c, lm)) return c.body(null, 304);
  setCacheHeaders(c, lm);
  const starsSeries = time('starsSeries', () => starsSeriesForRepo(detail.id));
  const releaseRows = time('releaseRows', () => leaders.releaseDownloadsForRepo(db, detail.id, 25));
  const relatedRepos = time('relatedRepos', () => repos.listRepoIdentsByOwner(db, owner, fullName));
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
    relatedRepos,
  });
  const title = detail.hacs_name
    ? `${detail.hacs_name} (${fullName}) — hacs-stats`
    : `${fullName} — hacs-stats`;
  if (profile) {
    c.header(
      'Server-Timing',
      Object.entries(timings)
        .map(([k, v]) => `${k};dur=${v}`)
        .join(', '),
    );
  }
  return c.html(renderLayout({ title, body }));
});

const SEARCH_PAGE_SIZE = 50;
const QUEUE_PAGE_SIZE = 50;

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

  const lm = catalogueLastModified();
  if (notModifiedSince(c, lm)) return c.body(null, 304);
  setCacheHeaders(c, lm);

  // Always run the query — /search is the single listing surface (home
  // sections, category cards, and direct visits all land here). An empty
  // q + no kind + default sort means "show everything sorted by name",
  // which is what the home page's "See all" links lean on. Pagination
  // keeps this from being a 7000-row firehose.
  const result = leaders.searchRepos(db, {
    q,
    sort,
    ...(kind !== undefined ? { kind } : {}),
    limit: SEARCH_PAGE_SIZE,
    offset: (page - 1) * SEARCH_PAGE_SIZE,
  });

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
  const lm = catalogueLastModified();
  if (notModifiedSince(c, lm)) return c.body(null, 304);
  setCacheHeaders(c, lm);
  const rows = leaders.pendingRepos(db, 200);
  return c.html(
    renderLayout({
      title: 'Pending repos — hacs-stats',
      body: renderPendingPage({ rows }),
    }),
  );
});

app.get('/removed', (c) => {
  const lm = catalogueLastModified();
  if (notModifiedSince(c, lm)) return c.body(null, 304);
  setCacheHeaders(c, lm);
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

app.get('/privacy', (c) =>
  c.html(renderLayout({ title: 'Privacy — hacs-stats', body: renderPrivacyPage() })),
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
  suppressed: "That's a HACS platform repo, not a HACS module — we don't list it.",
  stale:
    "That repo hasn't had a push in 3+ years. We hide repos that abandoned to keep the catalogue useful.",
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
  // Use recordUserSubmission instead of enqueueDiscovery — when the URL
  // is already in the queue from auto-discovery, this promotes the row's
  // source to user_submission so it surfaces ahead of unvouched
  // candidates in admin review. Also surfaces "already accepted /
  // rejected" outcomes back to the submitter as useful feedback rather
  // than the misleading "thanks, queued!" we used to always show.
  const outcome = discoveryQueue.recordUserSubmission(rwDb, { url, notes });
  const flash =
    outcome === 'already-accepted'
      ? {
          kind: 'ok' as const,
          text: `Good news — ${repoRaw} is already in the catalogue. See /r/${repoRaw}.`,
        }
      : outcome === 'already-rejected'
        ? {
            kind: 'err' as const,
            text: `${repoRaw} was previously rejected (manual or automatic). If you think that's wrong, open an issue against hacs-stats.`,
          }
        : outcome === 'promoted'
          ? {
              kind: 'ok' as const,
              text: `Thanks — ${repoRaw} was already in the discovery queue; your submission promotes it for priority review.`,
            }
          : outcome === 'already-pending'
            ? {
                kind: 'ok' as const,
                text: `${repoRaw} is already queued for review — your submission is on file.`,
              }
            : {
                kind: 'ok' as const,
                text: `Thanks — ${repoRaw} is queued for review and should appear in the catalogue after the next scrape if accepted.`,
              };
  return c.html(
    renderLayout({
      title: 'Submission received — hacs-stats',
      body: renderSubmitPage({ message: flash }),
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
  // Status filter — defaults to 'pending' so the admin's daily workflow
  // hasn't changed; explicit ?status=accepted/rejected/error surface the
  // audit trail (e.g. which rows did the band-discovery run auto-approve).
  const rawStatus = c.req.query('status') ?? 'pending';
  const status: 'pending' | 'accepted' | 'rejected' | 'error' =
    rawStatus === 'accepted' || rawStatus === 'rejected' || rawStatus === 'error'
      ? rawStatus
      : 'pending';
  const rawSort = c.req.query('sort') ?? 'discovered';
  const sort: 'discovered' | 'stars' | 'pushed' =
    rawSort === 'stars' || rawSort === 'pushed' ? rawSort : 'discovered';
  const dir: 'asc' | 'desc' = c.req.query('dir') === 'asc' ? 'asc' : 'desc';
  const page = parsePage(c.req.query('page'));
  const totals = discoveryQueue.countQueueByStatus(db);
  const pending = discoveryQueue.listQueueByStatus(
    db,
    status,
    QUEUE_PAGE_SIZE,
    sort,
    dir,
    (page - 1) * QUEUE_PAGE_SIZE,
  );
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
  // Accepted tab uses the shared listing format. Look up each accepted
  // queue row in `repos` (auto-approve inserted them; manual accepts also
  // upsert) and pass to the listing component. Newly-added rows that
  // haven't been scraped yet will show 0 stars / 0 downloads — that's
  // accurate ("we have no data yet"), not a bug.
  const listingRows =
    status === 'accepted'
      ? pending
          .map((it) => {
            const fullName = it.url.replace(/^.*github\.com\//, '');
            return leaders.repoDetailByFullName(db, fullName);
          })
          .filter((r): r is NonNullable<typeof r> => r !== undefined)
      : undefined;
  return c.html(
    renderLayout({
      title: 'Admin · queue — hacs-stats',
      body: renderAdminPage({
        pending: enriched,
        totals,
        status,
        sort,
        dir,
        page,
        pageSize: QUEUE_PAGE_SIZE,
        ...(msg !== undefined ? { flash: msg } : {}),
        ...(listingRows ? { listingRows } : {}),
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
  // Two response modes:
  //   - ?json=1 from the inline page script → 204/4xx without redirect,
  //     so the row can be removed in place without a full page reload.
  //   - default (no-JS fallback): the existing 303 → /admin/queue
  //     redirect so the page behaves the same when JS is off.
  const wantJson = c.req.query('json') === '1';
  const ok = (msg: string) =>
    wantJson ? c.body(null, 204) : c.redirect(`/admin/queue?msg=${encodeURIComponent(msg)}`, 303);
  const fail = (msg: string, status: 400 | 422 = 400) =>
    wantJson ? c.text(msg, status) : c.redirect(`/admin/queue?msg=${encodeURIComponent(msg)}`, 303);

  if (!url || (decision !== 'accept' && decision !== 'reject')) {
    return fail('bad request');
  }
  if (decision === 'reject') {
    discoveryQueue.setQueueStatus(rwDb, url, 'rejected', null);
    return ok('rejected');
  }
  const m = /github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(url);
  if (!m || !m[1] || !m[2]) return fail("can't parse url", 422);
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
    return fail('invalid kind in notes', 422);
  }
  const source = item?.source === 'user_submission' ? 'submitted' : 'discovered';
  repos.upsertRepo(rwDb, {
    owner,
    name,
    kind: kindFromNotes as RepoKind,
    source,
  });
  discoveryQueue.setQueueStatus(rwDb, url, 'accepted', null);
  return ok(`accepted ${owner}/${name}`);
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
    starsSeries: starsSeriesForRepo(detail.id),
    releases: leaders.releaseDownloadsForRepo(db, detail.id, 25),
  });
});

// Bind explicitly to 127.0.0.1. Node's default binds to `::` (IPv6) only,
// and on kernels with net.ipv6.bindv6only=1 (Debian/Ubuntu defaults in
// some configs) Caddy reverse-proxying to 127.0.0.1:PORT gets connection-
// refused even though the socket exists on the v6 side. We never want
// the Node process exposed publicly anyway — Caddy fronts everything —
// so localhost-only is the right default. Override via HOST env if you
// genuinely need the daemon reachable from another interface.
const HOST = process.env.HOST ?? '127.0.0.1';
const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, ({ port }) => {
  console.log(`hacs-stats web listening on http://${HOST}:${port}`);
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
