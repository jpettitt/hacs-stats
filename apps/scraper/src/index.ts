import { openDb, repos, resolveDatabasePath, runMigrations } from '@hacs-stats/db';

const DATABASE_PATH = resolveDatabasePath();

async function main(): Promise<void> {
  console.log(`[scrape] starting — DB: ${DATABASE_PATH}`);

  const db = openDb({ path: DATABASE_PATH });

  // Self-apply migrations on startup so the scrape never runs against an old
  // schema. The web process is a reader and trusts that the writer keeps the
  // schema current.
  const migrations = runMigrations(db);
  if (migrations.applied.length) {
    console.log(`[scrape] applied ${migrations.applied.length} migration(s):`, migrations.applied);
  }

  console.log(`[scrape] repos in DB: ${repos.countRepos(db)}`);

  // TODO (Phase 2): fetch HACS default lists, upsert into `repos`.
  // TODO (Phase 3): snapshot metadata + release downloads for every repo.
  // TODO (Phase 4): build stats_cache + roll up old snapshots.
  console.log('[scrape] stub — Phase 2 fills in real ingest work');

  db.close();
  console.log('[scrape] done');
}

main().catch((err) => {
  console.error('[scrape] failed:', err);
  process.exit(1);
});
