#!/usr/bin/env tsx
/**
 * `pnpm discover` — manual + (eventually) cron-fired wrapper for the
 * GitHub-code-search discovery worker. Reads existing repo full_names to
 * skip, runs the search, splits results:
 *
 *   - autoApprove candidates (stars > N + pushed within last M months) →
 *     inserted directly into `repos` with state='pending' (and a queue
 *     row with status='accepted' as an audit trail). Next scrape fills
 *     in their metadata as usual.
 *
 *   - everyone else → discovery_queue with status='pending' for manual
 *     review at /admin/queue.
 *
 * Env knobs (all optional):
 *   DISCOVERY_QUERY                Override the search query. Defaults to
 *                                  `filename:hacs.json`. Use size bands
 *                                  to break past GitHub's 1000-result cap:
 *                                  DISCOVERY_QUERY='filename:hacs.json size:80..90'
 *   DISCOVERY_MAX_PAGES            Max pages of search results (default 10
 *                                  = 1000 results per run).
 *   AUTOAPPROVE_MIN_STARS          Stars threshold (default 50).
 *   AUTOAPPROVE_KNOWN_OWNER_MIN_STARS
 *                                  Lower stars threshold when the
 *                                  candidate's owner already has a repo
 *                                  in the main HACS list (source='default').
 *                                  Trusted-owner discount — an unknown
 *                                  card from an established author beats
 *                                  an unknown card from an unknown author.
 *                                  Default 5.
 *   AUTOAPPROVE_MAX_AGE_MONTHS     Recency threshold against pushed_at
 *                                  (default 6).
 *   AUTOAPPROVE_OFF=1              Disable auto-approve, queue everything.
 */
import {
  discoveryQueue,
  openDb,
  repos,
  resolveDatabasePath,
  runMigrations,
  snapshots,
} from '@hacs-stats/db';
import { discoverCustomRepos } from '../apps/scraper/src/discovery.js';

const DATABASE_PATH = resolveDatabasePath();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const MAX_PAGES = Number(process.env.DISCOVERY_MAX_PAGES ?? 10);
const QUERY = process.env.DISCOVERY_QUERY ?? 'filename:hacs.json';
const AUTOAPPROVE_OFF = process.env.AUTOAPPROVE_OFF === '1';
const AUTOAPPROVE_MIN_STARS = Number(process.env.AUTOAPPROVE_MIN_STARS ?? 50);
const AUTOAPPROVE_KNOWN_OWNER_MIN_STARS = Number(
  process.env.AUTOAPPROVE_KNOWN_OWNER_MIN_STARS ?? 5,
);
const AUTOAPPROVE_MAX_AGE_MONTHS = Number(process.env.AUTOAPPROVE_MAX_AGE_MONTHS ?? 6);

if (!GITHUB_TOKEN) {
  console.error('[discover] GITHUB_TOKEN required');
  process.exit(2);
}

async function main(): Promise<void> {
  const db = openDb({ path: DATABASE_PATH });
  runMigrations(db);

  // Build "already known" set: every repo in `repos` + anything already in
  // discovery_queue (any source) so we don't re-queue the same URL.
  const known = new Set<string>();
  for (const r of db.raw.prepare<[], { full_name: string }>('SELECT full_name FROM repos').all()) {
    known.add(r.full_name);
  }
  const queueRows = db.raw.prepare<[], { url: string }>('SELECT url FROM discovery_queue').all();
  for (const row of queueRows) {
    const m = /github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/.exec(row.url);
    if (m?.[1]) known.add(m[1]);
  }

  // Trusted-owner set: every owner that already has at least one repo from
  // the canonical HACS lists (source='default'). Used by auto-approve to
  // lower the stars bar for candidates from established authors.
  const knownOwners = new Set<string>();
  for (const r of db.raw
    .prepare<[], { owner: string }>("SELECT DISTINCT owner FROM repos WHERE source = 'default'")
    .all()) {
    knownOwners.add(r.owner.toLowerCase());
  }

  console.log(`[discover] query: ${QUERY}`);
  console.log(`[discover] starting — ${known.size} already-known repos to skip`);
  console.log(
    `[discover] autoApprove: ${
      AUTOAPPROVE_OFF
        ? 'OFF'
        : `stars >= ${AUTOAPPROVE_MIN_STARS} (or >= ${AUTOAPPROVE_KNOWN_OWNER_MIN_STARS} for the ${knownOwners.size} trusted owners) AND pushed within last ${AUTOAPPROVE_MAX_AGE_MONTHS} months`
    }`,
  );
  console.log(`[discover] DB: ${DATABASE_PATH}`);

  const result = await discoverCustomRepos({
    token: GITHUB_TOKEN,
    maxPages: MAX_PAGES,
    query: QUERY,
    alreadyKnown: known,
    ...(AUTOAPPROVE_OFF
      ? {}
      : {
          autoApprove: {
            minStars: AUTOAPPROVE_MIN_STARS,
            maxAgeMonths: AUTOAPPROVE_MAX_AGE_MONTHS,
            knownOwnerMinStars: AUTOAPPROVE_KNOWN_OWNER_MIN_STARS,
            knownOwners,
          },
        }),
  });

  console.log('[discover] summary:', {
    inspected: result.inspected,
    candidates: result.candidates.length,
    auto_approved: result.autoApproved,
    queued_for_review: result.candidates.length - result.autoApproved,
    rejected_non_root: result.rejectedNonRoot,
    rejected_fork: result.rejectedFork,
    rejected_no_manifest: result.rejectedNoManifest,
    rejected_not_meaningful: result.rejectedNoMeaningfulFields,
    already_known: result.alreadyKnown,
  });

  if (result.candidates.length === 0) {
    console.log('[discover] nothing new');
    db.close();
    process.exit(0);
  }

  // Split + write in one transaction. Auto-approved entries hit BOTH the
  // repos table (so the next scrape picks them up) AND discovery_queue
  // (status='accepted') as an audit trail — admins can see what was
  // auto-approved alongside what they manually decided.
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
    for (const c of result.candidates) {
      if (c.autoApprove) {
        const repoId = repos.upsertRepo(db, {
          owner: c.owner,
          name: c.name,
          kind: c.kind,
          source: 'discovered',
        });
        // Seed today's snapshot with the stars we already know about so
        // the row doesn't show "0 stars" between auto-approval and the
        // next nightly scrape (which is what the user was seeing on
        // /pending). Forks / open_issues are placeholders — the next
        // scrape overwrites this row with the full GraphQL values.
        if (typeof c.stars === 'number') {
          snapshots.upsertRepoSnapshot(db, {
            repoId,
            snapshotDate: nowIso.slice(0, 10),
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

  console.log(
    `[discover] ${autoApprovedCount} auto-approved into repos, ${queuedCount} queued → /admin/queue`,
  );
  for (const c of result.candidates.slice(0, 5)) {
    console.log(`   • ${c.autoApprove ? 'AUTO' : 'queue'}  ${c.fullName}  (${c.kind})`);
  }
  if (result.candidates.length > 5) console.log(`   … and ${result.candidates.length - 5} more`);

  db.close();
}

main().catch((err) => {
  console.error('[discover] failed:', err);
  process.exit(1);
});
