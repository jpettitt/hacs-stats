import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as BetterSqlite } from 'better-sqlite3';

export type OpenMode = 'readwrite' | 'readonly';

export interface Db {
  raw: BetterSqlite;
  close(): void;
}

export interface OpenDbOptions {
  path: string;
  mode?: OpenMode;
}

export function openDb({ path, mode = 'readwrite' }: OpenDbOptions): Db {
  if (mode === 'readwrite') {
    // better-sqlite3 won't create parent dirs for us; mkdir before opening so a
    // fresh checkout works without a separate `mkdir data` step.
    mkdirSync(dirname(path), { recursive: true });
  }

  const raw = new Database(path, { readonly: mode === 'readonly', fileMustExist: false });

  // WAL lets the web process read while the scraper writes. NORMAL is the
  // recommended sync level under WAL — durable across crashes, ~10x faster
  // than FULL. busy_timeout keeps short contention from surfacing as errors.
  raw.pragma('journal_mode = WAL');
  raw.pragma('synchronous = NORMAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  raw.pragma('temp_store = MEMORY');
  raw.pragma('mmap_size = 268435456');

  return {
    raw,
    close: () => raw.close(),
  };
}
