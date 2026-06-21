import { openDb, repos, resolveDatabasePath, runMigrations } from '@hacs-stats/db';
import { mapLimit } from './concurrency.js';
import { fetchAllDefaultLists } from './hacs-default.js';
import { fetchHacsManifest, manifestFilename } from './hacs-manifest.js';

const DATABASE_PATH = resolveDatabasePath();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const MANIFEST_CONCURRENCY = Number(process.env.MANIFEST_CONCURRENCY ?? 12);

interface IngestResult {
  listEntries: number;
  reposBefore: number;
  reposAfter: number;
  manifestFetched: number;
  manifestFilenames: number;
  manifestFailures: number;
  durationSec: number;
}

async function ingest(): Promise<IngestResult> {
  const t0 = process.hrtime.bigint();
  const db = openDb({ path: DATABASE_PATH });

  const migrations = runMigrations(db);
  if (migrations.applied.length) {
    console.log(`[scrape] applied ${migrations.applied.length} migration(s):`, migrations.applied);
  }

  console.log('[scrape] step 1/3 — fetching HACS default lists');
  const { entries, byKind } = await fetchAllDefaultLists({ bearerToken: GITHUB_TOKEN });
  console.log(`[scrape]   ${entries.length} repos across ${Object.keys(byKind).length} categories`);
  for (const [kind, n] of Object.entries(byKind)) {
    console.log(`[scrape]     ${kind.padEnd(14)} ${n}`);
  }

  const reposBefore = repos.countRepos(db);

  console.log(`[scrape] step 2/3 — upserting ${entries.length} repos`);
  // One transaction for the whole batch — better-sqlite3 + WAL turns ~3000
  // individual inserts from "several seconds" into "tens of milliseconds".
  const upsertAll = db.raw.transaction((rows: typeof entries) => {
    for (const r of rows) {
      repos.upsertRepo(db, {
        owner: r.owner,
        name: r.name,
        kind: r.kind,
        source: 'default',
      });
    }
  });
  upsertAll(entries);
  const reposAfter = repos.countRepos(db);
  console.log(
    `[scrape]   ${reposAfter - reposBefore} new, ${entries.length - (reposAfter - reposBefore)} already known`,
  );

  console.log(
    `[scrape] step 3/3 — fetching hacs.json for ${entries.length} repos (concurrency ${MANIFEST_CONCURRENCY})`,
  );
  let manifestFetched = 0;
  let manifestFilenames = 0;
  let manifestFailures = 0;
  let lastLogged = 0;

  const results = await mapLimit(entries, MANIFEST_CONCURRENCY, async (e) => {
    const m = await fetchHacsManifest(e.fullName, { bearerToken: GITHUB_TOKEN });
    const filename = manifestFilename(m);
    repos.setHacsFilename(db, { fullName: e.fullName, hacsFilename: filename });
    return filename;
  });

  for (const r of results) {
    if (r.error) {
      manifestFailures++;
      continue;
    }
    manifestFetched++;
    if (r.value !== null) manifestFilenames++;
    // Sparse progress log so we don't spam 3000 lines.
    if (manifestFetched - lastLogged >= 500) {
      console.log(`[scrape]   …${manifestFetched}/${entries.length}`);
      lastLogged = manifestFetched;
    }
  }

  db.close();

  const durationSec = Number(process.hrtime.bigint() - t0) / 1e9;
  return {
    listEntries: entries.length,
    reposBefore,
    reposAfter,
    manifestFetched,
    manifestFilenames,
    manifestFailures,
    durationSec,
  };
}

ingest()
  .then((r) => {
    console.log('[scrape] done', {
      ...r,
      durationSec: Number(r.durationSec.toFixed(1)),
    });
    process.exit(0);
  })
  .catch((err) => {
    console.error('[scrape] failed:', err);
    process.exit(1);
  });
