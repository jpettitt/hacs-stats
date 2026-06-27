#!/usr/bin/env tsx
/**
 * `pnpm backfill:queue` — one-shot backfill for discovery_queue rows that
 * pre-date migration 0009 (stars / pushed_at / description added). For
 * every pending row with NULL stars, GET /repos/<full_name>, populate the
 * three new columns, and — applying the SAME auto-approve criteria the
 * live discover script uses — promote rows that now clear the bar into
 * `repos` (state='pending') with the queue row flipped to status='accepted'.
 *
 * Why this exists: bands 1-7 ran before migration 0009, so their queue rows
 * have NULL stars / pushed_at and the UI sorts them last + can't surface
 * the high-signal tail at all. This catches up without burning the
 * code-search rate-limit (it uses /repos REST, capped at 5000/hr — 3-4k
 * backfills fit comfortably).
 *
 * Env knobs (mirror discover.ts so behaviour matches):
 *   AUTOAPPROVE_MIN_STARS               default 50
 *   AUTOAPPROVE_KNOWN_OWNER_MIN_STARS   default 5
 *   AUTOAPPROVE_MAX_AGE_MONTHS          default 6
 *   AUTOAPPROVE_OFF=1                   skip the promotion step entirely
 */
import { openDb, repos, resolveDatabasePath, runMigrations, snapshots } from '@hacs-stats/db';

const DATABASE_PATH = resolveDatabasePath();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const AUTOAPPROVE_OFF = process.env.AUTOAPPROVE_OFF === '1';
const MIN_STARS = Number(process.env.AUTOAPPROVE_MIN_STARS ?? 50);
const KNOWN_OWNER_MIN_STARS = Number(process.env.AUTOAPPROVE_KNOWN_OWNER_MIN_STARS ?? 5);
const MAX_AGE_MONTHS = Number(process.env.AUTOAPPROVE_MAX_AGE_MONTHS ?? 6);
const USER_AGENT = 'hacs-stats/0.0.0 (+https://hacs-stats.dev)';

if (!GITHUB_TOKEN) {
  console.error('[backfill] GITHUB_TOKEN required');
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
    // Transient network blip (ETIMEDOUT etc) — caller treats as 'error' and
    // skips; can re-run the script to mop up.
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
  // The discover script stores `kind=<kind>` in the queue row's notes. We
  // restore that here so promoted rows go into `repos` with the right
  // category (rather than defaulting to integration).
  if (!notes) return 'integration';
  const m = /kind=([a-z_]+)/.exec(notes);
  return m?.[1] ?? 'integration';
}

async function main(): Promise<void> {
  const db = openDb({ path: DATABASE_PATH });
  runMigrations(db);

  // Trusted-owner set: owners with at least one source='default' repo.
  const knownOwners = new Set<string>();
  for (const r of db.raw
    .prepare<[], { owner: string }>("SELECT DISTINCT owner FROM repos WHERE source = 'default'")
    .all()) {
    knownOwners.add(r.owner.toLowerCase());
  }

  const rows = db.raw
    .prepare<[], { url: string; notes: string | null }>(
      "SELECT url, notes FROM discovery_queue WHERE status='pending' AND stars IS NULL",
    )
    .all();

  console.log(`[backfill] ${rows.length} pending NULL-stars rows to backfill`);
  console.log(
    `[backfill] autoApprove: ${AUTOAPPROVE_OFF ? 'OFF' : `stars >= ${MIN_STARS} (or >= ${KNOWN_OWNER_MIN_STARS} for ${knownOwners.size} trusted owners) AND pushed within ${MAX_AGE_MONTHS} months`}`,
  );

  const updateRow = db.raw.prepare(
    'UPDATE discovery_queue SET stars=?, pushed_at=?, description=? WHERE url=?',
  );
  const promoteQueueRow = db.raw.prepare(
    "UPDATE discovery_queue SET status='accepted', notes=? WHERE url=?",
  );

  const now = Date.now();
  let backfilled = 0;
  let promoted = 0;
  let notFound = 0;
  let errored = 0;
  let processed = 0;

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
      // Repo deleted / private since discovery. Mark the queue row so we
      // don't keep retrying — uses status='error' which is the existing
      // bucket for "something is wrong with this candidate".
      db.raw
        .prepare("UPDATE discovery_queue SET status='error', notes=? WHERE url=?")
        .run(`${row.notes ?? ''}; backfill: GitHub 404 (deleted or private)`, row.url);
      notFound++;
    } else if (details === 'error') {
      errored++;
    } else {
      updateRow.run(details.stars, details.pushedAt, details.description, row.url);
      backfilled++;

      if (!AUTOAPPROVE_OFF) {
        const ownerIsKnown = knownOwners.has(owner.toLowerCase());
        if (clearsAutoApprove(details, ownerIsKnown, now)) {
          const kind = kindFromNotes(row.notes) as
            | 'integration'
            | 'plugin'
            | 'theme'
            | 'appdaemon'
            | 'netdaemon'
            | 'python_script'
            | 'template';
          const repoId = repos.upsertRepo(db, { owner, name, kind, source: 'discovered' });
          // Seed today's snapshot with the stars we just fetched so the
          // pending row shows real numbers immediately (otherwise it sits
          // at 0 stars until the next scrape).
          snapshots.upsertRepoSnapshot(db, {
            repoId,
            snapshotDate: new Date().toISOString().slice(0, 10),
            stars: details.stars,
            forks: 0,
            openIssues: 0,
            lastCommitAt: details.pushedAt,
          });
          promoteQueueRow.run(
            `${row.notes ?? ''}; backfilled+auto-approved (stars=${details.stars}, pushed=${details.pushedAt.slice(0, 10)})`,
            row.url,
          );
          promoted++;
        }
      }
    }

    if (processed % 250 === 0) {
      console.log(
        `[backfill]   …${processed}/${rows.length} (backfilled ${backfilled}, promoted ${promoted}, 404 ${notFound}, err ${errored})`,
      );
    }
  }

  console.log('[backfill] done:', { processed, backfilled, promoted, notFound, errored });
  db.close();
}

main().catch((err) => {
  console.error('[backfill] failed:', err);
  process.exit(1);
});
