import { describe, expect, it } from 'vitest';
import { openDb } from '../src/client.js';
import { runMigrations } from '../src/migrations.js';
import { countRepos, getRepoByFullName, setHacsFilename, upsertRepo } from '../src/repos.js';

function freshDb() {
  // ':memory:' SQLite — schema applied per test, no fixture file management.
  const db = openDb({ path: ':memory:' });
  runMigrations(db);
  return db;
}

describe('upsertRepo', () => {
  it('inserts a new repo and returns its id', () => {
    const db = freshDb();
    const id = upsertRepo(db, {
      owner: 'jpettitt',
      name: 'weather-radar-card',
      kind: 'plugin',
      source: 'default',
    });
    expect(id).toBeGreaterThan(0);
    expect(countRepos(db)).toBe(1);

    const row = getRepoByFullName(db, 'jpettitt/weather-radar-card');
    expect(row?.owner).toBe('jpettitt');
    expect(row?.kind).toBe('plugin');
    expect(row?.source).toBe('default');
    expect(row?.hacs_filename).toBeNull();
  });

  it('on second upsert refreshes kind and source but not other columns', () => {
    const db = freshDb();
    const firstId = upsertRepo(db, {
      owner: 'a',
      name: 'b',
      kind: 'plugin',
      source: 'discovered',
    });
    setHacsFilename(db, { fullName: 'a/b', hacsFilename: 'b.js' });

    // Re-upsert with new kind/source.
    const secondId = upsertRepo(db, {
      owner: 'a',
      name: 'b',
      kind: 'integration',
      source: 'default',
    });
    expect(secondId).toBe(firstId);
    expect(countRepos(db)).toBe(1);

    const row = getRepoByFullName(db, 'a/b');
    expect(row?.kind).toBe('integration');
    expect(row?.source).toBe('default');
    // hacs_filename must NOT be wiped by a default-list refresh.
    expect(row?.hacs_filename).toBe('b.js');
  });

  it('handles many upserts inside a transaction', () => {
    const db = freshDb();
    const tx = db.raw.transaction((n: number) => {
      for (let i = 0; i < n; i++) {
        upsertRepo(db, {
          owner: 'owner',
          name: `repo-${i}`,
          kind: 'plugin',
          source: 'default',
        });
      }
    });
    tx(250);
    expect(countRepos(db)).toBe(250);
  });
});

describe('setHacsFilename', () => {
  it('writes filename and updates last_scraped_at', () => {
    const db = freshDb();
    upsertRepo(db, { owner: 'a', name: 'b', kind: 'plugin', source: 'default' });
    setHacsFilename(db, { fullName: 'a/b', hacsFilename: 'b.js' });
    const row = getRepoByFullName(db, 'a/b');
    expect(row?.hacs_filename).toBe('b.js');
    expect(row?.last_scraped_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('accepts null to clear the filename', () => {
    const db = freshDb();
    upsertRepo(db, { owner: 'a', name: 'b', kind: 'plugin', source: 'default' });
    setHacsFilename(db, { fullName: 'a/b', hacsFilename: 'b.js' });
    setHacsFilename(db, { fullName: 'a/b', hacsFilename: null });
    expect(getRepoByFullName(db, 'a/b')?.hacs_filename).toBeNull();
  });
});
