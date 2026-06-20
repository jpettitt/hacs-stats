import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/**
 * Walk up from this file until we find the workspace root. The DB path needs a
 * stable anchor: each pnpm script runs with a different CWD (root for
 * `pnpm migrate`, `apps/web/` for `pnpm dev:web`, etc.), so a CWD-relative
 * default would write to several different files depending on entrypoint.
 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Safety bound — we should hit the marker within ~6 hops in any layout we
  // ship; if not, something is very wrong with the install.
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, WORKSPACE_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find ${WORKSPACE_MARKER} above ${import.meta.url}`);
}

export function defaultDatabasePath(): string {
  return resolve(findRepoRoot(), 'data', 'dev.db');
}

export function resolveDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_PATH ?? defaultDatabasePath();
}
