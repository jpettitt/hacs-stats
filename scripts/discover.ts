#!/usr/bin/env tsx
/**
 * `pnpm discover` / `hacs-stats-discover.service` — one discovery sweep
 * against a single GitHub code-search query (defaults to
 * `filename:hacs.json`, which hits the 1000-result cap on a busy
 * catalogue). For full coverage, use `pnpm discover:bands` instead.
 *
 * Env knobs (all optional):
 *   DISCOVERY_QUERY              Override the search query.
 *   DISCOVERY_MAX_PAGES          Max pages of results (default 10 = 1000 results).
 *   AUTOAPPROVE_MIN_STARS        Stars threshold (default 50).
 *   AUTOAPPROVE_KNOWN_OWNER_MIN_STARS
 *                                Lower threshold for owners with an
 *                                existing source='default' repo (default 5).
 *   AUTOAPPROVE_MAX_AGE_MONTHS   Recency threshold against pushed_at (default 6).
 *   AUTOAPPROVE_OFF=1            Disable auto-approve, queue everything.
 */
import { openDb, resolveDatabasePath, runMigrations } from '@hacs-stats/db';
import {
  loadAlreadyKnown,
  loadKnownOwners,
  readAutoApproveEnv,
  runOneSweep,
} from './_discover-core.js';

const DATABASE_PATH = resolveDatabasePath();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const MAX_PAGES = Number(process.env.DISCOVERY_MAX_PAGES ?? 10);
const QUERY = process.env.DISCOVERY_QUERY ?? 'filename:hacs.json';

if (!GITHUB_TOKEN) {
  console.error('[discover] GITHUB_TOKEN required');
  process.exit(2);
}

async function main(): Promise<void> {
  const db = openDb({ path: DATABASE_PATH });
  runMigrations(db);

  const alreadyKnown = loadAlreadyKnown(db);
  const knownOwners = loadKnownOwners(db);
  const autoApprove = readAutoApproveEnv();

  console.log(`[discover] query: ${QUERY}`);
  console.log(`[discover] starting — ${alreadyKnown.size} already-known repos to skip`);
  console.log(
    `[discover] autoApprove: ${
      autoApprove.off
        ? 'OFF'
        : `stars >= ${autoApprove.minStars} (or >= ${autoApprove.knownOwnerMinStars} for the ${knownOwners.size} trusted owners) AND pushed within last ${autoApprove.maxAgeMonths} months`
    }`,
  );
  console.log(`[discover] DB: ${DATABASE_PATH}`);

  const c = await runOneSweep(
    db,
    QUERY,
    GITHUB_TOKEN,
    MAX_PAGES,
    alreadyKnown,
    knownOwners,
    autoApprove,
  );

  console.log('[discover] summary:', {
    inspected: c.inspected,
    candidates: c.candidates,
    auto_approved: c.autoApproved,
    queued_for_review: c.queued,
    rejected_non_root: c.rejectedNonRoot,
    rejected_fork: c.rejectedFork,
    rejected_no_manifest: c.rejectedNoManifest,
    rejected_not_meaningful: c.rejectedNotMeaningful,
    rejected_stale_3y: c.rejectedStale,
    rejected_zero_stars: c.rejectedZeroStars,
    already_known: c.alreadyKnown,
  });

  console.log(
    `[discover] ${c.autoApproved} auto-approved into repos, ${c.queued} queued → /admin/queue`,
  );

  db.close();
}

main().catch((err) => {
  console.error('[discover] failed:', err);
  process.exit(1);
});
