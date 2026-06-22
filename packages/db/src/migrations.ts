import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './client.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

interface MigrationRow {
  filename: string;
  applied_at: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export function runMigrations(db: Db, dir: string = MIGRATIONS_DIR): MigrationResult {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.raw
      .prepare<[], MigrationRow>('SELECT filename, applied_at FROM _migrations')
      .all()
      .map((r) => r.filename),
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const result: MigrationResult = { applied: [], skipped: [] };

  for (const file of files) {
    if (applied.has(file)) {
      result.skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    // Each migration runs in one transaction so a half-applied schema can't
    // leave us stuck between versions.
    const tx = db.raw.transaction((sqlInner: string, nameInner: string) => {
      db.raw.exec(sqlInner);
      db.raw
        .prepare('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)')
        .run(nameInner, new Date().toISOString());
    });
    tx(sql, file);
    result.applied.push(file);
  }

  return result;
}
