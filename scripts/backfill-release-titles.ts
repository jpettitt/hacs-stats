#!/usr/bin/env tsx
/**
 * `pnpm backfill:release-titles` — one-shot backfill for release rows
 * that pre-date migration 0012 (name + body columns). The daily scraper
 * uses ETag caching against GitHub's /releases endpoint, so old releases
 * never get re-fetched unless something in the page changes. This script
 * intentionally ignores the ETag so every repo with NULL-name releases
 * gets a fresh fetch and the name + body columns populate.
 *
 * Sequential to stay well under the 5000/hr REST quota. For ~4000 repos
 * at ~200ms each that's ~13 minutes of wall-clock. Run from the project
 * root with the env file sourced:
 *
 *   sudo -u hacs-stats bash -c '
 *     set -a; source /etc/hacs-stats/env; set +a
 *     cd /opt/hacs-stats
 *     pnpm backfill:release-titles
 *   '
 *
 * Idempotent — only touches repos with at least one NULL-name release,
 * so re-runs converge to a no-op.
 */
import { openDb, releases, resolveDatabasePath, runMigrations } from '@hacs-stats/db';
import { fetchReleases } from '../apps/scraper/src/github-releases.js';

const DATABASE_PATH = resolveDatabasePath();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const SLEEP_MS = Number(process.env.BACKFILL_SLEEP_MS ?? 100);
/** Cap the number of repos this run touches. 0 = no limit (production
 * mode). Useful for sampling against the dev DB before the full sweep. */
const BACKFILL_LIMIT = Number(process.env.BACKFILL_LIMIT ?? 0);

if (!GITHUB_TOKEN) {
  console.error('[backfill] GITHUB_TOKEN required');
  process.exit(2);
}

interface RepoRow {
  id: number;
  owner: string;
  name: string;
  full_name: string;
}

async function main(): Promise<void> {
  const db = openDb({ path: DATABASE_PATH });
  runMigrations(db);

  // Pick repos that have at least one release row missing both name and
  // body. EXISTS keeps the scan cheap; we don't care HOW MANY are NULL,
  // just whether any are.
  const repos = db.raw
    .prepare<[], RepoRow>(
      `SELECT r.id, r.owner, r.name, r.full_name
       FROM repos r
       WHERE EXISTS (
         SELECT 1 FROM releases rel
         WHERE rel.repo_id = r.id
           AND rel.name IS NULL
           AND rel.body IS NULL
       )
       ORDER BY r.full_name
       ${BACKFILL_LIMIT > 0 ? `LIMIT ${BACKFILL_LIMIT}` : ''}`,
    )
    .all();

  console.log(`[backfill] ${repos.length} repos to re-fetch /releases for`);
  console.log(`[backfill] inter-repo sleep: ${SLEEP_MS}ms`);

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let errored = 0;

  for (const r of repos) {
    processed++;
    try {
      // No etag passed → unconditional GET → always returns kind='modified'.
      const result = await fetchReleases({
        owner: r.owner,
        name: r.name,
        token: GITHUB_TOKEN,
      });
      if (result.kind === 'missing') {
        skipped++;
        continue;
      }
      if (result.kind !== 'modified') {
        skipped++;
        continue;
      }
      let updates = 0;
      for (const rel of result.releases ?? []) {
        if (rel.name === null && rel.body === null) continue;
        releases.upsertRelease(db, {
          repoId: r.id,
          tag: rel.tag,
          name: rel.name,
          body: rel.body,
          publishedAt: rel.publishedAt,
          isPrerelease: rel.isPrerelease,
          htmlUrl: rel.htmlUrl,
        });
        updates++;
      }
      if (updates > 0) updated++;
      else skipped++;
    } catch (err) {
      errored++;
      console.warn(`[backfill] ${r.full_name} failed: ${(err as Error).message}`);
    }

    if (processed % 100 === 0) {
      console.log(
        `[backfill]   …${processed}/${repos.length} (updated ${updated}, skipped ${skipped}, err ${errored})`,
      );
    }
    if (SLEEP_MS > 0) await new Promise((res) => setTimeout(res, SLEEP_MS));
  }

  console.log('[backfill] done:', { processed, updated, skipped, errored });
  db.close();
}

main().catch((err) => {
  console.error('[backfill] failed:', err);
  process.exit(1);
});
