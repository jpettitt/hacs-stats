#!/usr/bin/env tsx
import { openDb, resolveDatabasePath, runMigrations } from '@hacs-stats/db';

const DATABASE_PATH = resolveDatabasePath();

const db = openDb({ path: DATABASE_PATH });
const { applied, skipped } = runMigrations(db);
db.close();

if (applied.length === 0) {
  console.log(
    `✅ Up to date (${skipped.length} migration${skipped.length === 1 ? '' : 's'} already applied)`,
  );
} else {
  console.log(`✅ Applied ${applied.length} migration(s):`);
  for (const f of applied) console.log(`   • ${f}`);
}
console.log(`   DB: ${DATABASE_PATH}`);
