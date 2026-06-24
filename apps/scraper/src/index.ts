import {
  openDb,
  releases,
  repos,
  resolveDatabasePath,
  runMigrations,
  snapshots,
} from '@hacs-stats/db';
import { mapLimit } from './concurrency.js';
import { fetchRepoMetadataBatches } from './github-graphql.js';
import { fetchReleases } from './github-releases.js';
import { fetchAllDefaultLists } from './hacs-default.js';
import { fetchHacsManifest, manifestFilename, manifestName } from './hacs-manifest.js';
import { RateLimitGuard } from './rate-limit.js';
import { applyRetention } from './retention.js';
import { computeStatsCache } from './rollup.js';
import { todayUtcIsoDate } from './snapshot-date.js';

const DATABASE_PATH = resolveDatabasePath();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const MANIFEST_CONCURRENCY = Number(process.env.MANIFEST_CONCURRENCY ?? 12);
const RELEASES_CONCURRENCY = Number(process.env.RELEASES_CONCURRENCY ?? 12);
// `process.env.SCRAPE_LIMIT ? …` would treat '0' as truthy (non-empty string)
// AND `0` as falsy after Number(), then `LIMIT 0` would silently become "no
// limit" — exactly the surprising behaviour we DON'T want. Explicitly check
// for undefined so SCRAPE_LIMIT=0 means "0 repos".
const SCRAPE_LIMIT =
  process.env.SCRAPE_LIMIT !== undefined ? Number(process.env.SCRAPE_LIMIT) : undefined;
const SKIP_DEFAULTS = process.env.SKIP_DEFAULTS === '1';
// SNAPSHOT_DATE=YYYY-MM-DD overrides the UTC "today" for this run. Lets dev
// fabricate multi-day history without waiting for UTC midnight. Logged
// loudly when set so a fake-time run isn't mistaken for a real one.
const SNAPSHOT_DATE = process.env.SNAPSHOT_DATE;

interface IngestResult {
  defaults: { listEntries: number; reposAfter: number };
  manifests: { fetched: number; withFilename: number; failures: number } | null;
  metadata: { batchesFetched: number; snapshotsWritten: number; missing: number } | null;
  releases: {
    repos: number;
    notModified: number;
    missing: number;
    releasesWritten: number;
    assetSnapshotsWritten: number;
    failures: number;
  } | null;
  rollup: { rowsWritten: number; durationSec: number; asOfDate: string };
  retention: {
    repoSnapshotsDeleted: number;
    assetSnapshotsDeleted: number;
    durationSec: number;
  };
  rateLimit: { remaining: number };
  durationSec: number;
}

async function ingest(): Promise<IngestResult> {
  const t0 = process.hrtime.bigint();
  const today = SNAPSHOT_DATE ?? todayUtcIsoDate();
  if (SNAPSHOT_DATE) {
    console.log(`[scrape] ⚠️  SNAPSHOT_DATE=${SNAPSHOT_DATE} — writing under a FAKE date`);
  }
  const guard = new RateLimitGuard();
  const db = openDb({ path: DATABASE_PATH });

  const migrations = runMigrations(db);
  if (migrations.applied.length) {
    console.log(`[scrape] applied ${migrations.applied.length} migration(s):`, migrations.applied);
  }

  // --- Phase 2 step 1a: HACS default list catalogue refresh --------------
  let listEntries = 0;
  if (SKIP_DEFAULTS) {
    console.log('[scrape] step 1a — SKIP_DEFAULTS=1, reusing existing default-list repos');
  } else {
    console.log('[scrape] step 1a — fetching HACS default lists');
    const { entries, byKind } = await fetchAllDefaultLists({ bearerToken: GITHUB_TOKEN });
    listEntries = entries.length;
    console.log(
      `[scrape]   ${entries.length} repos across ${Object.keys(byKind).length} categories`,
    );
    const upsertAll = db.raw.transaction((rows: typeof entries) => {
      for (const r of rows) {
        repos.upsertRepo(db, { owner: r.owner, name: r.name, kind: r.kind, source: 'default' });
      }
    });
    upsertAll(entries);
  }

  // --- Phase 2 step 1b: hacs.json backfill --------------------------------
  // Targets EVERY repo in the catalogue missing either hacs_filename or
  // hacs_name, not just default-list entries. Originally the manifest fetch
  // was nested inside step 1a and filtered to `entries` — that worked for
  // default-list repos but silently skipped submitted/discovered repos
  // (Phase 6 additions), which then displayed without their hacs.json name
  // or canonical asset filename forever. Pull it out as its own step so it
  // runs regardless of SKIP_DEFAULTS and covers every row.
  console.log('[scrape] step 1b — backfilling hacs.json for repos missing it');
  const needManifest = db.raw
    .prepare<[], { full_name: string }>(
      'SELECT full_name FROM repos WHERE hacs_filename IS NULL OR hacs_name IS NULL ORDER BY id',
    )
    .all();
  console.log(
    `[scrape]   ${needManifest.length} repos need a manifest (concurrency ${MANIFEST_CONCURRENCY})`,
  );

  let manifests: IngestResult['manifests'] = null;
  if (needManifest.length > 0) {
    let fetched = 0;
    let withFilename = 0;
    let failures = 0;
    const results = await mapLimit(needManifest, MANIFEST_CONCURRENCY, async (e) => {
      const m = await fetchHacsManifest(e.full_name, { bearerToken: GITHUB_TOKEN });
      const filename = manifestFilename(m);
      const name = manifestName(m);
      repos.setHacsManifest(db, {
        fullName: e.full_name,
        hacsFilename: filename,
        hacsName: name,
      });
      return filename;
    });
    for (const r of results) {
      if (r.error) failures++;
      else {
        fetched++;
        if (r.value !== null) withFilename++;
      }
    }
    manifests = { fetched, withFilename, failures };
  }

  const allRepos = repos.listAllRepoIdents(db, SCRAPE_LIMIT);
  console.log(
    `[scrape]   ${allRepos.length} repos to snapshot${SCRAPE_LIMIT !== undefined ? ` (SCRAPE_LIMIT=${SCRAPE_LIMIT})` : ''}`,
  );

  // Token is required for Phase 3 — GraphQL needs auth, REST releases at
  // 60/hr unauthed gets us nowhere. Fail loud instead of silently skipping.
  let metadata: IngestResult['metadata'] = null;
  let releasesSummary: IngestResult['releases'] = null;
  if (!GITHUB_TOKEN) {
    console.warn('[scrape] step 2/3 — SKIPPED (no GITHUB_TOKEN; metadata + releases require auth)');
  } else {
    // --- Phase 3 step A: GraphQL repo metadata → repo_snapshots -----------
    console.log(
      `[scrape] step 2/3 — GraphQL metadata for ${allRepos.length} repos (batches of 100)`,
    );
    let batchesFetched = 0;
    let snapshotsWritten = 0;
    let missing = 0;
    const fullNameToId = new Map(allRepos.map((r) => [r.full_name, r.id]));
    const idents = allRepos.map((r) => ({ owner: r.owner, name: r.name }));

    for await (const batch of fetchRepoMetadataBatches(idents, { token: GITHUB_TOKEN, guard })) {
      batchesFetched++;
      const writeBatch = db.raw.transaction((items: typeof batch) => {
        for (const m of items) {
          if (m.stars === null) {
            missing++;
            continue;
          }
          const repoId = fullNameToId.get(m.fullName);
          if (repoId === undefined) continue;
          // Two separate writes per repo:
          //   - snapshot row (fast-moving: stars/forks/issues + last commit)
          //   - repo row (slow-moving: description / archived / default_branch)
          // The slow-moving fields are properties of the repo, not a daily
          // measurement, so they live on `repos`, not on every snapshot.
          snapshots.upsertRepoSnapshot(db, {
            repoId,
            snapshotDate: today,
            stars: m.stars,
            forks: m.forks ?? 0,
            openIssues: m.openIssues ?? 0,
            lastCommitAt: m.lastCommitAt,
          });
          repos.updateRepoMetadata(db, {
            repoId,
            description: m.description,
            archived: m.archived ?? false,
            isFork: m.isFork ?? false,
            defaultBranch: m.defaultBranch,
          });
          snapshotsWritten++;
        }
      });
      writeBatch(batch);
    }
    metadata = { batchesFetched, snapshotsWritten, missing };
    console.log(`[scrape]   ${snapshotsWritten} snapshots written, ${missing} repos missing`);

    // --- Phase 3 step B: REST releases → releases + release_asset_snapshots -
    console.log(
      `[scrape] step 3/3 — releases for ${allRepos.length} repos (concurrency ${RELEASES_CONCURRENCY})`,
    );
    let reposDone = 0;
    let notModified = 0;
    let missingRepos = 0;
    let releasesWritten = 0;
    let assetSnapshotsWritten = 0;
    let failures = 0;
    let lastLogged = 0;

    const results = await mapLimit(allRepos, RELEASES_CONCURRENCY, async (r) => {
      await guard.waitIfNeeded();
      const etag = repos.getReleasesEtag(db, r.id);
      const result = await fetchReleases({
        owner: r.owner,
        name: r.name,
        token: GITHUB_TOKEN,
        etag,
        guard,
      });
      // All DB writes for this repo go inside a single tx — cheaper, and we
      // don't want a half-written release row visible to the reader.
      const writeOne = db.raw.transaction(() => {
        if (result.kind === 'not-modified') return;
        if (result.kind === 'missing') {
          // Could mark archived; for now just leave the row alone. Phase 7
          // adds a "stale / abandoned" classifier that'll handle this.
          return;
        }
        if (result.etag !== undefined) repos.setReleasesEtag(db, r.id, result.etag);
        for (const rel of result.releases ?? []) {
          const releaseId = releases.upsertRelease(db, {
            repoId: r.id,
            tag: rel.tag,
            publishedAt: rel.publishedAt,
            isPrerelease: rel.isPrerelease,
            htmlUrl: rel.htmlUrl,
          });
          releasesWritten++;
          for (const asset of rel.assets) {
            releases.upsertReleaseAssetSnapshot(db, {
              releaseId,
              assetName: asset.name,
              snapshotDate: today,
              downloadCount: asset.downloadCount,
            });
            assetSnapshotsWritten++;
          }
        }
        repos.markScraped(db, r.id);
      });
      writeOne();
      return result.kind;
    });

    for (const r of results) {
      if (r.error) {
        failures++;
        continue;
      }
      reposDone++;
      if (r.value === 'not-modified') notModified++;
      if (r.value === 'missing') missingRepos++;
      if (reposDone - lastLogged >= 250) {
        console.log(
          `[scrape]   …${reposDone}/${allRepos.length} (${notModified} cached, ${failures} failed)`,
        );
        lastLogged = reposDone;
      }
    }
    releasesSummary = {
      repos: reposDone,
      notModified,
      missing: missingRepos,
      releasesWritten,
      assetSnapshotsWritten,
      failures,
    };
  }

  // --- Phase 4 step: rollup + retention -----------------------------------
  // Always run, even when Phase 3 was skipped — keeps stats_cache and
  // retention thresholds in sync with whatever data IS in the DB. Cheap.
  console.log('[scrape] step 4/4 — recomputing stats_cache and applying retention');
  const rollup = computeStatsCache(db, { asOfDate: today });
  console.log(
    `[scrape]   stats_cache: ${rollup.rowsWritten} rows (${rollup.durationSec.toFixed(2)}s)`,
  );
  const retention = applyRetention(db, { asOfDate: today });
  if (retention.repoSnapshotsDeleted || retention.assetSnapshotsDeleted) {
    console.log(
      `[scrape]   retention: collapsed ${retention.repoSnapshotsDeleted} repo_snapshots, ${retention.assetSnapshotsDeleted} asset_snapshots`,
    );
  } else {
    console.log('[scrape]   retention: nothing old enough to collapse yet');
  }

  const reposAfter = repos.countRepos(db);
  db.close();

  return {
    defaults: { listEntries, reposAfter },
    manifests,
    metadata,
    releases: releasesSummary,
    rollup,
    retention,
    rateLimit: { remaining: guard.snapshot().remaining },
    durationSec: Number(process.hrtime.bigint() - t0) / 1e9,
  };
}

ingest()
  .then((r) => {
    console.log('[scrape] done', { ...r, durationSec: Number(r.durationSec.toFixed(1)) });
    process.exit(0);
  })
  .catch((err) => {
    console.error('[scrape] failed:', err);
    process.exit(1);
  });
