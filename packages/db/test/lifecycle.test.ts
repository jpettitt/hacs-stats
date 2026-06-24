import { describe, expect, it } from 'vitest';
import { openDb } from '../src/client.js';
import { runMigrations } from '../src/migrations.js';
import {
  deleteRepoCascade,
  getRepoByFullName,
  listRepoIdentsByOwner,
  markRepoFailure,
  markRepoSuccess,
  renameRepo,
  upsertRepo,
} from '../src/repos.js';

function freshDb() {
  const db = openDb({ path: ':memory:' });
  runMigrations(db);
  return db;
}

function seed(db: ReturnType<typeof freshDb>, owner: string, name: string): number {
  return upsertRepo(db, { owner, name, kind: 'plugin', source: 'submitted' });
}

describe('markRepoSuccess', () => {
  it('flips a pending repo to active and clears failure counters', () => {
    const db = freshDb();
    const id = seed(db, 'a', 'b');
    expect(getRepoByFullName(db, 'a/b')?.['state' as 'kind']).toBe('pending');
    markRepoSuccess(db, id);
    const row = getRepoByFullName(db, 'a/b') as {
      state: string;
      first_failure_at: string | null;
      consecutive_failures: number;
    };
    expect(row.state).toBe('active');
    expect(row.first_failure_at).toBeNull();
    expect(row.consecutive_failures).toBe(0);
  });

  it('recovers an offline repo back to active', () => {
    const db = freshDb();
    const id = seed(db, 'a', 'b');
    // Set up an offline row.
    db.raw
      .prepare(
        "UPDATE repos SET state='offline', first_failure_at='2026-06-01T00:00:00Z', consecutive_failures=5 WHERE id=?",
      )
      .run(id);
    markRepoSuccess(db, id);
    const row = getRepoByFullName(db, 'a/b') as {
      state: string;
      first_failure_at: string | null;
      consecutive_failures: number;
    };
    expect(row.state).toBe('active');
    expect(row.first_failure_at).toBeNull();
    expect(row.consecutive_failures).toBe(0);
  });
});

describe('markRepoFailure — pending', () => {
  it('first failure on a pending repo keeps it pending, counter goes to 1', () => {
    const db = freshDb();
    const id = seed(db, 'a', 'b');
    const out = markRepoFailure(db, id, { now: new Date('2026-06-22T00:00:00Z') });
    expect(out).toEqual({ action: 'kept', newState: 'pending' });
    const row = getRepoByFullName(db, 'a/b') as { state: string; consecutive_failures: number };
    expect(row.state).toBe('pending');
    expect(row.consecutive_failures).toBe(1);
  });

  it('second failure on a pending repo DELETES the row', () => {
    const db = freshDb();
    const id = seed(db, 'a', 'b');
    markRepoFailure(db, id, { now: new Date('2026-06-22T00:00:00Z') });
    const out = markRepoFailure(db, id, { now: new Date('2026-06-23T00:00:00Z') });
    expect(out).toEqual({ action: 'deleted' });
    expect(getRepoByFullName(db, 'a/b')).toBeUndefined();
  });
});

describe('markRepoFailure — active → offline → removed', () => {
  it('active + first failure → offline with first_failure_at=now', () => {
    const db = freshDb();
    const id = seed(db, 'a', 'b');
    markRepoSuccess(db, id); // → active
    const out = markRepoFailure(db, id, { now: new Date('2026-06-22T00:00:00Z') });
    expect(out).toEqual({ action: 'kept', newState: 'offline' });
    const row = getRepoByFullName(db, 'a/b') as { state: string; first_failure_at: string | null };
    expect(row.state).toBe('offline');
    expect(row.first_failure_at).toBe('2026-06-22T00:00:00.000Z');
  });

  it('offline stays offline while < removedAfterDays', () => {
    const db = freshDb();
    const id = seed(db, 'a', 'b');
    markRepoSuccess(db, id);
    markRepoFailure(db, id, { now: new Date('2026-06-22T00:00:00Z') });
    const out = markRepoFailure(db, id, {
      now: new Date('2026-07-15T00:00:00Z'), // ~23 days later
      removedAfterDays: 30,
    });
    expect(out).toEqual({ action: 'kept', newState: 'offline' });
  });

  it('offline → removed once first_failure_at is older than removedAfterDays', () => {
    const db = freshDb();
    const id = seed(db, 'a', 'b');
    markRepoSuccess(db, id);
    markRepoFailure(db, id, { now: new Date('2026-06-01T00:00:00Z') });
    const out = markRepoFailure(db, id, {
      now: new Date('2026-07-15T00:00:00Z'), // ~44 days later
      removedAfterDays: 30,
    });
    expect(out).toEqual({ action: 'kept', newState: 'removed' });
    expect((getRepoByFullName(db, 'a/b') as { state: string }).state).toBe('removed');
  });

  it('removed is terminal — no further state change on more failures', () => {
    const db = freshDb();
    const id = seed(db, 'a', 'b');
    db.raw.prepare("UPDATE repos SET state='removed' WHERE id=?").run(id);
    const out = markRepoFailure(db, id);
    expect(out).toEqual({ action: 'kept', newState: 'removed' });
  });
});

describe('renameRepo (redirect handling)', () => {
  it('renames a repo in place, preserving id', () => {
    const db = freshDb();
    const id = seed(db, 'old', 'repo');
    const r = renameRepo(db, id, 'new/repo');
    expect(r).toEqual({ ok: true });
    expect(getRepoByFullName(db, 'old/repo')).toBeUndefined();
    const row = getRepoByFullName(db, 'new/repo');
    expect(row?.id).toBe(id);
    expect(row?.owner).toBe('new');
    expect(row?.name).toBe('repo');
  });

  it('fails with reason="duplicate" when the new name already exists', () => {
    const db = freshDb();
    seed(db, 'new', 'repo'); // already in catalogue
    const oldId = seed(db, 'old', 'repo');
    const r = renameRepo(db, oldId, 'new/repo');
    expect(r).toEqual({ ok: false, reason: 'duplicate' });
    // The OLD row stays put (caller is expected to delete it as a duplicate).
    expect(getRepoByFullName(db, 'old/repo')?.id).toBe(oldId);
  });

  it('fails with reason="malformed" for nonsense inputs', () => {
    const db = freshDb();
    const id = seed(db, 'a', 'b');
    expect(renameRepo(db, id, 'no-slash')).toEqual({ ok: false, reason: 'malformed' });
    expect(renameRepo(db, id, '/leading')).toEqual({ ok: false, reason: 'malformed' });
    expect(renameRepo(db, id, 'a/b/c')).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('deleteRepoCascade', () => {
  it('removes the repo + all its dependent rows', () => {
    const db = freshDb();
    const id = seed(db, 'a', 'b');
    db.raw
      .prepare(
        'INSERT INTO repo_snapshots (repo_id, snapshot_date, stars, forks, open_issues) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, '2026-06-22', 1, 0, 0);
    deleteRepoCascade(db, id);
    expect(getRepoByFullName(db, 'a/b')).toBeUndefined();
    const snapshots = db.raw
      .prepare('SELECT COUNT(*) AS n FROM repo_snapshots WHERE repo_id = ?')
      .get(id) as { n: number };
    expect(snapshots.n).toBe(0);
  });
});

describe('listRepoIdentsByOwner (related projects)', () => {
  it('returns every repo by the same owner, excluding the one passed in', () => {
    const db = freshDb();
    seed(db, 'piitaya', 'lovelace-mushroom');
    seed(db, 'piitaya', 'card-mod-helpers');
    seed(db, 'piitaya', 'misc');
    seed(db, 'someoneelse', 'unrelated');
    const r = listRepoIdentsByOwner(db, 'piitaya', 'piitaya/lovelace-mushroom');
    expect(r.map((x) => x.full_name).sort()).toEqual(['piitaya/card-mod-helpers', 'piitaya/misc']);
  });

  it('omits the exclude filter when not supplied', () => {
    const db = freshDb();
    seed(db, 'owner', 'a');
    seed(db, 'owner', 'b');
    expect(listRepoIdentsByOwner(db, 'owner').map((r) => r.full_name)).toEqual([
      'owner/a',
      'owner/b',
    ]);
  });
});
