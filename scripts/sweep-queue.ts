#!/usr/bin/env tsx
/**
 * `pnpm sweep:queue` — re-evaluate every status='pending' row in
 * discovery_queue against current GitHub state. Three outcomes per row:
 *
 *   1. Repo now clears auto-approve (stars + freshness) → promote to
 *      `repos` (state='pending') and flip the queue row to 'accepted',
 *      same path the live discover script uses.
 *   2. Repo's pushed_at is now older than the 1-year discovery floor →
 *      auto-reject (status='rejected') with an audit note. Same rule the
 *      sweep ran one-shot today, but applied on an ongoing basis.
 *   3. Neither — update the cached stars/pushed_at/description in the
 *      queue row so admin browsing reflects current numbers, then leave
 *      the row pending for manual triage.
 *
 * Designed for a weekly cron alongside the daily scrape. Runs sequentially
 * (~5k pending × ~150ms/REST ≈ 12 min) to stay well under the 5000/hr
 * REST quota.
 *
 * Env knobs mirror discover.ts:
 *   AUTOAPPROVE_MIN_STARS               default 50
 *   AUTOAPPROVE_KNOWN_OWNER_MIN_STARS   default 5
 *   AUTOAPPROVE_MAX_AGE_MONTHS          default 6
 *   AUTOAPPROVE_OFF=1                   skip promotion, only reject + refresh
 *   SWEEP_STALE_YEARS                   default 1; cutoff matches discover's
 *                                       1-year floor for unattended channels
 *   SWEEP_LIMIT                         max rows to process this run (default
 *                                       ALL). Useful for first-time / paced runs.
 */
import { openDb, repos, resolveDatabasePath, runMigrations, snapshots } from '@hacs-stats/db';

const DATABASE_PATH = resolveDatabasePath();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const AUTOAPPROVE_OFF = process.env.AUTOAPPROVE_OFF === '1';
const MIN_STARS = Number(process.env.AUTOAPPROVE_MIN_STARS ?? 50);
const KNOWN_OWNER_MIN_STARS = Number(process.env.AUTOAPPROVE_KNOWN_OWNER_MIN_STARS ?? 5);
const MAX_AGE_MONTHS = Number(process.env.AUTOAPPROVE_MAX_AGE_MONTHS ?? 6);
const STALE_YEARS = Number(process.env.SWEEP_STALE_YEARS ?? 1);
const SWEEP_LIMIT = Number(process.env.SWEEP_LIMIT ?? 0); // 0 = no cap
const USER_AGENT = 'hacs-stats/0.0.0 (+https://hacs-stats.dev)';
const STALE_MS = STALE_YEARS * 365 * 24 * 60 * 60 * 1000;

if (!GITHUB_TOKEN) {
  console.error('[sweep] GITHUB_TOKEN required');
  process.exit(2);
}

interface RepoDetails {
  stars: number;
  pushedAt: string;
  description: string | null;
}

async function fetchDetails(fullName: string): Promise<RepoDetails | 'not-found' | 'error'> {
  try {
    const res = await fetch(`https://api.github.com/repos/${fullName}`, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': USER_AGENT,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.status === 404) return 'not-found';
    if (!res.ok) return 'error';
    const body = (await res.json()) as {
      stargazers_count?: number;
      pushed_at?: string;
      description?: string | null;
    };
    if (typeof body.stargazers_count !== 'number' || typeof body.pushed_at !== 'string') {
      return 'error';
    }
    return {
      stars: body.stargazers_count,
      pushedAt: body.pushed_at,
      description: typeof body.description === 'string' ? body.description : null,
    };
  } catch {
    return 'error';
  }
}

function clearsAutoApprove(d: RepoDetails, ownerIsKnown: boolean, now: number): boolean {
  const minStars = ownerIsKnown ? KNOWN_OWNER_MIN_STARS : MIN_STARS;
  if (d.stars < minStars) return false;
  const pushedMs = Date.parse(d.pushedAt);
  if (!Number.isFinite(pushedMs)) return false;
  const cutoffMs = now - MAX_AGE_MONTHS * 30 * 24 * 60 * 60 * 1000;
  return pushedMs >= cutoffMs;
}

function kindFromNotes(notes: string | null): string {
  if (!notes) return 'integration';
  const m = /kind=([a-z_]+)/.exec(notes);
  return m?.[1] ?? 'integration';
}

async function main(): Promise<void> {
  const db = openDb({ path: DATABASE_PATH });
  runMigrations(db);

  const knownOwners = new Set<string>();
  for (const r of db.raw
    .prepare<[], { owner: string }>("SELECT DISTINCT owner FROM repos WHERE source = 'default'")
    .all()) {
    knownOwners.add(r.owner.toLowerCase());
  }

  // Pull every pending row. SWEEP_LIMIT caps the run for paced first-time
  // execution — pass via env when you don't want to walk the whole table.
  const limitClause = SWEEP_LIMIT > 0 ? `LIMIT ${SWEEP_LIMIT}` : '';
  const rows = db.raw
    .prepare<[], { url: string; notes: string | null; source: string }>(
      `SELECT url, notes, source FROM discovery_queue WHERE status='pending' ${limitClause}`,
    )
    .all();

  console.log(`[sweep] ${rows.length} pending rows to re-evaluate`);
  console.log(
    `[sweep] thresholds: stars >= ${MIN_STARS} (or >= ${KNOWN_OWNER_MIN_STARS} for ${knownOwners.size} trusted owners), pushed within ${MAX_AGE_MONTHS} months, stale-reject at ${STALE_YEARS}yr`,
  );

  const refreshRow = db.raw.prepare(
    'UPDATE discovery_queue SET stars=?, pushed_at=?, description=? WHERE url=?',
  );
  const promoteRow = db.raw.prepare(
    "UPDATE discovery_queue SET status='accepted', notes=?, stars=?, pushed_at=?, description=? WHERE url=?",
  );
  const rejectRow = db.raw.prepare(
    "UPDATE discovery_queue SET status='rejected', notes=?, stars=?, pushed_at=?, description=? WHERE url=?",
  );
  const flagNotFound = db.raw.prepare(
    "UPDATE discovery_queue SET status='error', notes=? WHERE url=?",
  );

  const now = Date.now();
  let processed = 0;
  let promoted = 0;
  let rejectedStale = 0;
  let rejectedZeroStars = 0;
  let refreshed = 0;
  let notFound = 0;
  let errored = 0;

  for (const row of rows) {
    processed++;
    const m = /github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(row.url);
    if (!m) {
      errored++;
      continue;
    }
    const owner = m[1] as string;
    const name = m[2] as string;
    const fullName = `${owner}/${name}`;

    const details = await fetchDetails(fullName);
    if (details === 'not-found') {
      flagNotFound.run(`${row.notes ?? ''}; sweep: GitHub 404 (deleted or private)`, row.url);
      notFound++;
    } else if (details === 'error') {
      errored++;
    } else {
      const ownerIsKnown = knownOwners.has(owner.toLowerCase());
      const pushedMs = Date.parse(details.pushedAt);
      const isStale =
        Number.isFinite(pushedMs) &&
        now - pushedMs > STALE_MS &&
        // Spare user submissions from the 1-year sweep — the submitter
        // is vouching for it, so the 3-year listing filter applies
        // instead. This mirrors the asymmetry in /submit.
        row.source !== 'user_submission';

      if (isStale) {
        rejectRow.run(
          `${row.notes ?? ''}; sweep: stale (no push in ${STALE_YEARS}+ years)`,
          details.stars,
          details.pushedAt,
          details.description,
          row.url,
        );
        rejectedStale++;
      } else if (details.stars === 0 && row.source !== 'user_submission') {
        // Same as discover: 0-star repos auto-reject. If they pick up
        // stars later the auto-reject is reversible (skip-set excludes
        // auto-rejected rows). User submissions are spared on the same
        // logic as the staleness rule.
        rejectRow.run(
          `${row.notes ?? ''}; sweep: 0 stars`,
          details.stars,
          details.pushedAt,
          details.description,
          row.url,
        );
        rejectedZeroStars++;
      } else if (!AUTOAPPROVE_OFF && clearsAutoApprove(details, ownerIsKnown, now)) {
        const kind = kindFromNotes(row.notes) as
          | 'integration'
          | 'plugin'
          | 'theme'
          | 'appdaemon'
          | 'netdaemon'
          | 'python_script'
          | 'template';
        const repoId = repos.upsertRepo(db, { owner, name, kind, source: 'discovered' });
        // Seed today's snapshot so the row shows real stars immediately
        // (same idea as scripts/discover.ts and backfill-queue.ts).
        snapshots.upsertRepoSnapshot(db, {
          repoId,
          snapshotDate: new Date(now).toISOString().slice(0, 10),
          stars: details.stars,
          forks: 0,
          openIssues: 0,
          lastCommitAt: details.pushedAt,
        });
        promoteRow.run(
          `${row.notes ?? ''}; sweep: auto-approved (stars=${details.stars}, pushed=${details.pushedAt.slice(0, 10)})`,
          details.stars,
          details.pushedAt,
          details.description,
          row.url,
        );
        promoted++;
      } else {
        refreshRow.run(details.stars, details.pushedAt, details.description, row.url);
        refreshed++;
      }
    }

    if (processed % 250 === 0) {
      console.log(
        `[sweep]   …${processed}/${rows.length} (promoted ${promoted}, rejected_stale ${rejectedStale}, rejected_zero ${rejectedZeroStars}, refreshed ${refreshed}, 404 ${notFound}, err ${errored})`,
      );
    }
  }

  console.log('[sweep] done:', {
    processed,
    promoted,
    rejected_stale: rejectedStale,
    rejected_zero_stars: rejectedZeroStars,
    refreshed,
    notFound,
    errored,
  });
  db.close();
}

main().catch((err) => {
  console.error('[sweep] failed:', err);
  process.exit(1);
});
