export { openDb, type Db, type OpenMode } from './client.js';
export { runMigrations, MIGRATIONS_DIR } from './migrations.js';
export { defaultDatabasePath, resolveDatabasePath } from './paths.js';
export * as repos from './repos.js';
