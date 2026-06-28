#!/usr/bin/env tsx
/**
 * `pnpm discover:bands` — walk 15 size-banded `filename:hacs.json`
 * queries to break past GitHub's 1000-result code-search cap. Each band
 * is empirically sized so its result set stays under 1000.
 *
 * Runs entirely in one process (no subprocess spawn) so the systemd
 * unit can invoke it directly without the pnpm-preflight collisions
 * we hit when each band was a separate `pnpm discover` call.
 *
 * Inter-band sleep keeps us under GitHub's 30-req/min code-search
 * limit while still finishing the whole sweep in 25-40 min.
 *
 * Env knobs mirror discover.ts (AUTOAPPROVE_*, DISCOVERY_MAX_PAGES).
 * BANDS_SLEEP_SEC tunes the inter-band pause (default 65s).
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
const SLEEP_SEC = Number(process.env.BANDS_SLEEP_SEC ?? 65);

if (!GITHUB_TOKEN) {
  console.error('[bands] GITHUB_TOKEN required');
  process.exit(2);
}

const BANDS = [
  'size:<40',
  'size:40..50',
  'size:50..60',
  'size:60..70',
  'size:70..80',
  'size:80..90',
  'size:90..100',
  'size:100..115',
  'size:115..130',
  'size:130..150',
  'size:150..170',
  'size:170..200',
  'size:200..250',
  'size:250..500',
  'size:>500',
];

async function main(): Promise<void> {
  const db = openDb({ path: DATABASE_PATH });
  runMigrations(db);

  const alreadyKnown = loadAlreadyKnown(db);
  const knownOwners = loadKnownOwners(db);
  const autoApprove = readAutoApproveEnv();

  console.log(`[bands] walking ${BANDS.length} size bands`);
  console.log(`[bands] starting — ${alreadyKnown.size} already-known repos to skip`);
  console.log(
    `[bands] autoApprove: ${
      autoApprove.off
        ? 'OFF'
        : `stars >= ${autoApprove.minStars} (or >= ${autoApprove.knownOwnerMinStars} for the ${knownOwners.size} trusted owners) AND pushed within last ${autoApprove.maxAgeMonths} months`
    }`,
  );
  console.log(`[bands] DB: ${DATABASE_PATH}`);
  console.log(`[bands] inter-band sleep: ${SLEEP_SEC}s`);

  const totals = {
    inspected: 0,
    autoApproved: 0,
    queued: 0,
    rejectedStale: 0,
    rejectedZeroStars: 0,
  };

  for (let i = 0; i < BANDS.length; i++) {
    const band = BANDS[i];
    const query = `filename:hacs.json ${band}`;
    console.log(`\n[bands] ${i + 1}/${BANDS.length} — ${query}`);
    try {
      const c = await runOneSweep(
        db,
        query,
        GITHUB_TOKEN,
        MAX_PAGES,
        alreadyKnown,
        knownOwners,
        autoApprove,
      );
      totals.inspected += c.inspected;
      totals.autoApproved += c.autoApproved;
      totals.queued += c.queued;
      totals.rejectedStale += c.rejectedStale;
      totals.rejectedZeroStars += c.rejectedZeroStars;
      console.log(
        `[bands]   inspected=${c.inspected} auto=${c.autoApproved} queue=${c.queued} stale=${c.rejectedStale} zero=${c.rejectedZeroStars}`,
      );
    } catch (err) {
      // Don't abort the whole sweep on a single transient failure — log
      // and continue. Common cause: ETIMEDOUT on a single REST call.
      console.error(`[bands] band "${band}" FAILED:`, (err as Error).message);
    }
    if (i < BANDS.length - 1 && SLEEP_SEC > 0) {
      console.log(`[bands] sleeping ${SLEEP_SEC}s before next band…`);
      await new Promise((r) => setTimeout(r, SLEEP_SEC * 1000));
    }
  }

  console.log('\n[bands] totals:', totals);
  db.close();
}

main().catch((err) => {
  console.error('[bands] failed:', err);
  process.exit(1);
});
