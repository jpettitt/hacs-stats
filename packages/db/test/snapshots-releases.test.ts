import { describe, expect, it } from 'vitest';
import { openDb } from '../src/client.js';
import { runMigrations } from '../src/migrations.js';
import {
  countAssetSnapshotsForDate,
  countReleasesForRepo,
  upsertRelease,
  upsertReleaseAssetSnapshot,
} from '../src/releases.js';
import { upsertRepo } from '../src/repos.js';
import { countSnapshotsForDate, upsertRepoSnapshot } from '../src/snapshots.js';

function freshDb() {
  const db = openDb({ path: ':memory:' });
  runMigrations(db);
  return db;
}

function seedRepo(db: ReturnType<typeof freshDb>): number {
  return upsertRepo(db, { owner: 'a', name: 'b', kind: 'plugin', source: 'default' });
}

describe('upsertRepoSnapshot', () => {
  it('inserts a new daily snapshot', () => {
    const db = freshDb();
    const id = seedRepo(db);
    upsertRepoSnapshot(db, {
      repoId: id,
      snapshotDate: '2026-06-21',
      stars: 100,
      forks: 5,
      openIssues: 2,
      lastCommitAt: '2026-06-20T12:00:00Z',
    });
    expect(countSnapshotsForDate(db, '2026-06-21')).toBe(1);
  });

  it('a second write for the same day overwrites (idempotent re-runs)', () => {
    const db = freshDb();
    const id = seedRepo(db);
    upsertRepoSnapshot(db, {
      repoId: id,
      snapshotDate: '2026-06-21',
      stars: 100,
      forks: 5,
      openIssues: 2,
      lastCommitAt: null,
    });
    upsertRepoSnapshot(db, {
      repoId: id,
      snapshotDate: '2026-06-21',
      stars: 101,
      forks: 6,
      openIssues: 1,
      lastCommitAt: '2026-06-21T08:00:00Z',
    });
    const row = db.raw
      .prepare('SELECT stars, forks, last_commit_at FROM repo_snapshots WHERE repo_id = ?')
      .get(id) as { stars: number; forks: number; last_commit_at: string };
    expect(row.stars).toBe(101);
    expect(row.forks).toBe(6);
    expect(row.last_commit_at).toBe('2026-06-21T08:00:00Z');
    expect(countSnapshotsForDate(db, '2026-06-21')).toBe(1);
  });
});

describe('upsertRelease', () => {
  it('inserts a new release and refreshes mutable fields on second insert', () => {
    const db = freshDb();
    const repoId = seedRepo(db);
    const id1 = upsertRelease(db, {
      repoId,
      tag: 'v1.0.0',
      publishedAt: '2026-01-01T00:00:00Z',
      isPrerelease: false,
      htmlUrl: 'https://example/1',
    });
    const id2 = upsertRelease(db, {
      repoId,
      tag: 'v1.0.0',
      publishedAt: '2026-01-02T00:00:00Z', // upstream backfilled a date
      isPrerelease: true,
      htmlUrl: 'https://example/1-renamed',
    });
    expect(id2).toBe(id1);
    expect(countReleasesForRepo(db, repoId)).toBe(1);
    const row = db.raw
      .prepare('SELECT published_at, is_prerelease, html_url FROM releases WHERE id = ?')
      .get(id1) as { published_at: string; is_prerelease: number; html_url: string };
    expect(row.published_at).toBe('2026-01-02T00:00:00Z');
    expect(row.is_prerelease).toBe(1);
    expect(row.html_url).toBe('https://example/1-renamed');
  });
});

describe('upsertReleaseAssetSnapshot', () => {
  it('records the download count and updates on same-day re-run', () => {
    const db = freshDb();
    const repoId = seedRepo(db);
    const releaseId = upsertRelease(db, {
      repoId,
      tag: 'v1',
      publishedAt: '2026-01-01T00:00:00Z',
      isPrerelease: false,
      htmlUrl: '',
    });
    upsertReleaseAssetSnapshot(db, {
      releaseId,
      assetName: 'card.js',
      snapshotDate: '2026-06-21',
      downloadCount: 100,
    });
    upsertReleaseAssetSnapshot(db, {
      releaseId,
      assetName: 'card.js',
      snapshotDate: '2026-06-21',
      downloadCount: 105,
    });
    const row = db.raw
      .prepare('SELECT download_count FROM release_asset_snapshots WHERE release_id = ?')
      .get(releaseId) as { download_count: number };
    expect(row.download_count).toBe(105);
    expect(countAssetSnapshotsForDate(db, '2026-06-21')).toBe(1);
  });
});
