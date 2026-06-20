import { openDb, repos, resolveDatabasePath } from '@hacs-stats/db';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { renderHome } from './pages/home.js';

const DATABASE_PATH = resolveDatabasePath();
const PORT = Number(process.env.PORT ?? 3000);

// Web is strictly a reader — open read-only so we can never accidentally write
// from the user-facing process. The scraper holds the only RW handle.
const db = openDb({ path: DATABASE_PATH, mode: 'readonly' });

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.get('/api/stats/overview', (c) => c.json({ repos: repos.countRepos(db) }));

app.get('/', (c) => c.html(renderHome({ repoCount: repos.countRepos(db) })));

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
