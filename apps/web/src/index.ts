import { openDb, repos, resolveDatabasePath } from '@hacs-stats/db';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { renderHome } from './pages/home.js';

const DATABASE_PATH = resolveDatabasePath();
const PORT = Number(process.env.PORT ?? 3000);

// Web is strictly a reader — open read-only so we can never accidentally write
// from the user-facing process. The scraper holds the only RW handle.
const db = openDb({ path: DATABASE_PATH, mode: 'readonly' });

interface LeaderRow {
  full_name: string;
  kind: string;
  stars: number;
  downloads_30d: number;
  star_delta_30d: number;
  top_version_30d: string | null;
}

function topByStars(limit = 20): LeaderRow[] {
  return db.raw
    .prepare<[number], LeaderRow>(`
      SELECT
        r.full_name, r.kind,
        COALESCE(latest.stars, 0)              AS stars,
        COALESCE(sc.total_downloads_30d, 0)    AS downloads_30d,
        COALESCE(sc.star_delta_30d, 0)         AS star_delta_30d,
        sc.top_version_30d                     AS top_version_30d
      FROM repos r
      LEFT JOIN stats_cache sc ON sc.repo_id = r.id
      LEFT JOIN (
        SELECT repo_id, stars
        FROM repo_snapshots
        WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM repo_snapshots)
      ) latest ON latest.repo_id = r.id
      ORDER BY stars DESC
      LIMIT ?
    `)
    .all(limit);
}

function topByDownloads30d(limit = 20): LeaderRow[] {
  return db.raw
    .prepare<[number], LeaderRow>(`
      SELECT
        r.full_name, r.kind,
        COALESCE(latest.stars, 0)              AS stars,
        COALESCE(sc.total_downloads_30d, 0)    AS downloads_30d,
        COALESCE(sc.star_delta_30d, 0)         AS star_delta_30d,
        sc.top_version_30d                     AS top_version_30d
      FROM repos r
      LEFT JOIN stats_cache sc ON sc.repo_id = r.id
      LEFT JOIN (
        SELECT repo_id, stars
        FROM repo_snapshots
        WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM repo_snapshots)
      ) latest ON latest.repo_id = r.id
      ORDER BY downloads_30d DESC, stars DESC
      LIMIT ?
    `)
    .all(limit);
}

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

app.get('/api/stats/overview', (c) =>
  c.json({
    repos: repos.countRepos(db),
    topByStars: topByStars(20),
    topByDownloads30d: topByDownloads30d(20),
  }),
);

app.get('/', (c) =>
  c.html(
    renderHome({
      repoCount: repos.countRepos(db),
      topByStars: topByStars(15),
      topByDownloads30d: topByDownloads30d(15),
    }),
  ),
);

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
