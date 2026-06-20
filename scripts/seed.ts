#!/usr/bin/env tsx
import { openDb, repos, resolveDatabasePath, runMigrations } from '@hacs-stats/db';

const DATABASE_PATH = resolveDatabasePath();

const db = openDb({ path: DATABASE_PATH });

console.log('1. Applying migrations…');
const { applied } = runMigrations(db);
if (applied.length) console.log(`   applied: ${applied.join(', ')}`);
else console.log('   ✅ No migrations to apply');

console.log(`\n2. Current repo count: ${repos.countRepos(db)}`);
console.log('\nTODO (Phase 2): fetch HACS default lists and populate `repos`.');
console.log('   For now, the local DB has the schema but no rows.');
console.log(`\nDB: ${DATABASE_PATH}`);

db.close();
