/**
 * Shared core for the discovery scripts.
 *
 * `scripts/discover.ts` runs ONE sweep against the default
 * `filename:hacs.json` query — that hits GitHub's 1000-result cap.
 *
 * `scripts/discover-bands.ts` runs the same sweep against 15 size-band
 * queries to break past the cap. Originally it spawned `pnpm discover`
 * as a child process per band, but pnpm 11's preflight collides with the
 * systemd ProtectSystem=strict hardening — so the bands script now uses
 * this helper directly and stays in one process.
 *
 * Both entry points end up calling `runOneSweep` for each query string;
 * results are committed in a single transaction per band.
 */
import type { Db } from '@hacs-stats/db';
import { repos, snapshots } from '@hacs-stats/db';
import { discoverCustomRepos } from '../apps/scraper/src/discovery.js';

export interface AutoApproveEnv {
  off: boolean;
  minStars: number;
  knownOwnerMinStars: number;
  maxAgeMonths: number;
}

/**
 * Build the trusted-owner set (every distinct owner of a source='default'
 * repo). Used by auto-approve to grant a lower stars threshold to
 * candidates from established HACS authors.
 */
export function loadKnownOwners(db: Db): Set<string> {
  const out = new Set<string>();
  for (const r of db.raw
    .prepare<[], { owner: string }>("SELECT DISTINCT owner FROM repos WHERE source = 'default'")
    .all()) {
    out.add(r.owner.toLowerCase());
  }
  return out;
}

/**
 * Build the skip-set. EXCLUDES auto-rejected rows (notes contain
 * 'auto-rejected' or 'sweep:') so they can be re-discovered if the
 * upstream condition has changed. INCLUDES manually-rejected rows so
 * admin decisions stay sticky.
 */
export function loadAlreadyKnown(db: Db): Set<string> {
  const out = new Set<string>();
  for (const r of db.raw.prepare<[], { full_name: string }>('SELECT full_name FROM repos').all()) {
    out.add(r.full_name);
  }
  for (const row of db.raw
    .prepare<[], { url: string }>(`SELECT url FROM discovery_queue
       WHERE NOT (
         status = 'rejected'
         AND notes IS NOT NULL
         AND (notes LIKE '%auto-rejected%' OR notes LIKE '%sweep:%')
       )`)
    .all()) {
    const m = /github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/.exec(row.url);
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}

export interface SweepCounters {
  inspected: number;
  candidates: number;
  autoApproved: number;
  queued: number;
  rejectedNonRoot: number;
  rejectedFork: number;
  rejectedNoManifest: number;
  rejectedNotMeaningful: number;
  rejectedStale: number;
  rejectedZeroStars: number;
  alreadyKnown: number;
}

/**
 * Run a single discover sweep against `query` and persist both the
 * auto-approves (→ repos + queue 'accepted') and the survivors
 * (→ queue 'pending'). Re-uses the trusted-owner and known-URL sets
 * the caller assembled once.
 */
export async function runOneSweep(
  db: Db,
  query: string,
  token: string,
  maxPages: number,
  alreadyKnown: Set<string>,
  knownOwners: Set<string>,
  autoApprove: AutoApproveEnv,
): Promise<SweepCounters> {
  const result = await discoverCustomRepos({
    token,
    maxPages,
    query,
    alreadyKnown,
    ...(autoApprove.off
      ? {}
      : {
          autoApprove: {
            minStars: autoApprove.minStars,
            maxAgeMonths: autoApprove.maxAgeMonths,
            knownOwnerMinStars: autoApprove.knownOwnerMinStars,
            knownOwners,
          },
        }),
  });

  const insertQueuePending = db.raw.prepare(
    `INSERT INTO discovery_queue (url, source, discovered_at, status, notes, stars, pushed_at, description)
     VALUES (?, 'code_search', ?, 'pending', ?, ?, ?, ?)
     ON CONFLICT(url) DO NOTHING`,
  );
  const insertQueueAccepted = db.raw.prepare(
    `INSERT INTO discovery_queue (url, source, discovered_at, status, notes, stars, pushed_at, description)
     VALUES (?, 'code_search', ?, 'accepted', ?, ?, ?, ?)
     ON CONFLICT(url) DO NOTHING`,
  );

  let autoApprovedCount = 0;
  let queuedCount = 0;
  const tx = db.raw.transaction(() => {
    const nowIso = new Date().toISOString();
    const today = nowIso.slice(0, 10);
    for (const c of result.candidates) {
      // Add the freshly-seen URL to the in-memory skip-set so subsequent
      // bands in the same process don't re-emit it. (Each band re-asks
      // GitHub and the same repo can match more than one size range
      // when it sits exactly on a boundary.)
      alreadyKnown.add(c.fullName);
      if (c.autoApprove) {
        const repoId = repos.upsertRepo(db, {
          owner: c.owner,
          name: c.name,
          kind: c.kind,
          source: 'discovered',
        });
        if (typeof c.stars === 'number') {
          snapshots.upsertRepoSnapshot(db, {
            repoId,
            snapshotDate: today,
            stars: c.stars,
            forks: 0,
            openIssues: 0,
            lastCommitAt: c.pushedAt ?? null,
          });
        }
        insertQueueAccepted.run(
          c.htmlUrl,
          nowIso,
          `kind=${c.kind}; auto-approved (stars=${c.stars ?? '?'}, pushed=${(c.pushedAt ?? '').slice(0, 10)})`,
          c.stars ?? null,
          c.pushedAt ?? null,
          c.description ?? null,
        );
        autoApprovedCount++;
      } else {
        insertQueuePending.run(
          c.htmlUrl,
          nowIso,
          `kind=${c.kind}`,
          c.stars ?? null,
          c.pushedAt ?? null,
          c.description ?? null,
        );
        queuedCount++;
      }
    }
  });
  tx();

  return {
    inspected: result.inspected,
    candidates: result.candidates.length,
    autoApproved: autoApprovedCount,
    queued: queuedCount,
    rejectedNonRoot: result.rejectedNonRoot,
    rejectedFork: result.rejectedFork,
    rejectedNoManifest: result.rejectedNoManifest,
    rejectedNotMeaningful: result.rejectedNoMeaningfulFields,
    rejectedStale: result.rejectedStale,
    rejectedZeroStars: result.rejectedZeroStars,
    alreadyKnown: result.alreadyKnown,
  };
}

export function readAutoApproveEnv(): AutoApproveEnv {
  return {
    off: process.env.AUTOAPPROVE_OFF === '1',
    minStars: Number(process.env.AUTOAPPROVE_MIN_STARS ?? 50),
    knownOwnerMinStars: Number(process.env.AUTOAPPROVE_KNOWN_OWNER_MIN_STARS ?? 5),
    maxAgeMonths: Number(process.env.AUTOAPPROVE_MAX_AGE_MONTHS ?? 6),
  };
}
