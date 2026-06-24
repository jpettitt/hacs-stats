#!/usr/bin/env tsx
/**
 * `pnpm discover` — manual + (eventually) cron-fired wrapper for the
 * GitHub-code-search discovery worker. Reads existing repo full_names to
 * skip, runs the search, inserts new candidates into discovery_queue.
 *
 * Designed to be fired weekly on the VPS via systemd timer. Sequence:
 *   discover → land in queue → admin reviews at /admin/queue → accept →
 *   daily scrape picks up the new row → metadata/snapshots/etc.
 */
import { openDb, resolveDatabasePath, runMigrations } from '@hacs-stats/db';
import { discoverCustomRepos } from '../apps/scraper/src/discovery.js';

const DATABASE_PATH = resolveDatabasePath();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const MAX_PAGES = Number(process.env.DISCOVERY_MAX_PAGES ?? 10);

if (!GITHUB_TOKEN) {
  console.error('[discover] GITHUB_TOKEN required');
  process.exit(2);
}

const db = openDb({ path: DATABASE_PATH });
runMigrations(db);

// Build the "already known" set: everything currently in `repos` plus
// anything already sitting in `discovery_queue` from a prior run.
const known = new Set<string>();
for (const r of db.raw.prepare<[], { full_name: string }>('SELECT full_name FROM repos').all()) {
  known.add(r.full_name);
}
const queueRows = db.raw
  .prepare<[], { url: string }>("SELECT url FROM discovery_queue WHERE source = 'code_search'")
  .all();
// queue URLs are stored as full GitHub URLs; extract owner/repo for the dedupe.
for (const row of queueRows) {
  const m = /github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/.exec(row.url);
  if (m?.[1]) known.add(m[1]);
}

console.log(`[discover] starting — ${known.size} already-known repos to skip`);
console.log(`[discover] DB: ${DATABASE_PATH}`);

const result = await discoverCustomRepos({
  token: GITHUB_TOKEN,
  maxPages: MAX_PAGES,
  alreadyKnown: known,
});

console.log('[discover] summary:', {
  inspected: result.inspected,
  candidates: result.candidates.length,
  rejected_non_root: result.rejectedNonRoot,
  rejected_fork: result.rejectedFork,
  rejected_no_manifest: result.rejectedNoManifest,
  rejected_not_meaningful: result.rejectedNoMeaningfulFields,
  already_known: result.alreadyKnown,
});

if (result.candidates.length === 0) {
  console.log('[discover] nothing new to queue');
  db.close();
  process.exit(0);
}

const insertQueue = db.raw.prepare(
  `INSERT INTO discovery_queue (url, source, discovered_at, status)
   VALUES (?, 'code_search', ?, 'pending')
   ON CONFLICT(url) DO NOTHING`,
);
const insertAll = db.raw.transaction((items: typeof result.candidates) => {
  for (const c of items) {
    insertQueue.run(c.htmlUrl, new Date().toISOString());
  }
});
insertAll(result.candidates);

console.log(`[discover] queued ${result.candidates.length} new candidates → /admin/queue`);
// Print the first 5 so the user can sanity-check the worker.
for (const c of result.candidates.slice(0, 5)) console.log(`   • ${c.fullName}`);
if (result.candidates.length > 5) console.log(`   … and ${result.candidates.length - 5} more`);

db.close();
