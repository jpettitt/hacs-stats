import {
  openDb,
  releases,
  repos,
  runMigrations,
  snapshots,
  starHistory,
  statsCache,
} from '@hacs-stats/db';
import { describe, expect, it } from 'vitest';
import { computeStatsCache } from '../src/rollup.js';

function freshDb() {
  const db = openDb({ path: ':memory:' });
  runMigrations(db);
  return db;
}

function seedRepo(
  db: ReturnType<typeof freshDb>,
  owner: string,
  name: string,
  hacsFilename: string | null = null,
): number {
  const id = repos.upsertRepo(db, { owner, name, kind: 'plugin', source: 'default' });
  if (hacsFilename) repos.setHacsFilename(db, { fullName: `${owner}/${name}`, hacsFilename });
  return id;
}

function seedRelease(db: ReturnType<typeof freshDb>, repoId: number, tag: string): number {
  return releases.upsertRelease(db, {
    repoId,
    tag,
    publishedAt: '2026-01-01T00:00:00Z',
    isPrerelease: false,
    htmlUrl: '',
  });
}

function seedAssetSnapshot(
  db: ReturnType<typeof freshDb>,
  releaseId: number,
  assetName: string,
  date: string,
  downloadCount: number,
) {
  releases.upsertReleaseAssetSnapshot(db, {
    releaseId,
    assetName,
    snapshotDate: date,
    downloadCount,
  });
}

function seedRepoSnapshot(
  db: ReturnType<typeof freshDb>,
  repoId: number,
  date: string,
  stars: number,
) {
  snapshots.upsertRepoSnapshot(db, {
    repoId,
    snapshotDate: date,
    stars,
    forks: 0,
    openIssues: 0,
    lastCommitAt: null,
  });
}

describe('computeStatsCache — downloads', () => {
  it('day-1: deltas are all zero (no baseline yet)', () => {
    const db = freshDb();
    const r = seedRepo(db, 'a', 'b');
    const rel = seedRelease(db, r, 'v1');
    seedAssetSnapshot(db, rel, 'card.js', '2026-06-21', 100);
    computeStatsCache(db, { asOfDate: '2026-06-21', nowIso: 'test' });
    const row = statsCache.getStatsCacheRow(db, r);
    expect(row?.total_downloads_30d).toBe(0);
    expect(row?.top_version_downloads_30d).toBe(0);
  });

  it('honours hacs_filename — only that asset is counted', () => {
    const db = freshDb();
    const r = seedRepo(db, 'a', 'b', 'card.js');
    const rel = seedRelease(db, r, 'v1');
    // Two assets on one release. Only `card.js` should contribute.
    seedAssetSnapshot(db, rel, 'card.js', '2026-05-22', 100);
    seedAssetSnapshot(db, rel, 'card.js', '2026-06-21', 150);
    seedAssetSnapshot(db, rel, 'source.zip', '2026-05-22', 1000);
    seedAssetSnapshot(db, rel, 'source.zip', '2026-06-21', 9999);
    computeStatsCache(db, { asOfDate: '2026-06-21', nowIso: 'test' });
    const row = statsCache.getStatsCacheRow(db, r);
    expect(row?.total_downloads_30d).toBe(50); // 150 - 100, source.zip ignored
    expect(row?.top_version_30d).toBe('v1');
    expect(row?.top_version_downloads_30d).toBe(50);
  });

  it('without hacs_filename, takes MAX delta across assets (not SUM)', () => {
    // MAX over SUM is a deliberate choice: many repos publish bundled
    // assets (icons, signed builds, multiple .js variants) that all get
    // downloaded together. SUM would inflate by ~Nx; MAX picks the
    // dominant asset as the install proxy.
    const db = freshDb();
    const r = seedRepo(db, 'a', 'b');
    const rel = seedRelease(db, r, 'v1');
    seedAssetSnapshot(db, rel, 'main.js', '2026-05-22', 100);
    seedAssetSnapshot(db, rel, 'main.js', '2026-06-21', 110); // delta 10
    seedAssetSnapshot(db, rel, 'icon-a.svg', '2026-05-22', 100);
    seedAssetSnapshot(db, rel, 'icon-a.svg', '2026-06-21', 109); // delta 9
    seedAssetSnapshot(db, rel, 'icon-b.svg', '2026-05-22', 100);
    seedAssetSnapshot(db, rel, 'icon-b.svg', '2026-06-21', 108); // delta 8
    computeStatsCache(db, { asOfDate: '2026-06-21', nowIso: 'test' });
    const row = statsCache.getStatsCacheRow(db, r);
    // MAX(10, 9, 8) = 10. SUM would have given 27.
    expect(row?.total_downloads_30d).toBe(10);
  });

  it('single-asset release: MAX behaves the same as SUM', () => {
    const db = freshDb();
    const r = seedRepo(db, 'a', 'b'); // no hacs_filename
    const rel = seedRelease(db, r, 'v1');
    seedAssetSnapshot(db, rel, 'only.zip', '2026-05-22', 100);
    seedAssetSnapshot(db, rel, 'only.zip', '2026-06-21', 142);
    computeStatsCache(db, { asOfDate: '2026-06-21', nowIso: 'test' });
    expect(statsCache.getStatsCacheRow(db, r)?.total_downloads_30d).toBe(42);
  });

  it('picks the release with the highest delta as top_version_30d', () => {
    const db = freshDb();
    const r = seedRepo(db, 'a', 'b', 'card.js');
    const v1 = seedRelease(db, r, 'v1');
    const v2 = seedRelease(db, r, 'v2');
    seedAssetSnapshot(db, v1, 'card.js', '2026-05-22', 1000);
    seedAssetSnapshot(db, v1, 'card.js', '2026-06-21', 1010); // delta 10
    seedAssetSnapshot(db, v2, 'card.js', '2026-05-22', 50);
    seedAssetSnapshot(db, v2, 'card.js', '2026-06-21', 200); // delta 150
    computeStatsCache(db, { asOfDate: '2026-06-21', nowIso: 'test' });
    const row = statsCache.getStatsCacheRow(db, r);
    expect(row?.top_version_30d).toBe('v2');
    expect(row?.top_version_downloads_30d).toBe(150);
    expect(row?.total_downloads_30d).toBe(160);
  });

  it('ignores snapshots outside the 30-day window', () => {
    const db = freshDb();
    const r = seedRepo(db, 'a', 'b', 'card.js');
    const rel = seedRelease(db, r, 'v1');
    seedAssetSnapshot(db, rel, 'card.js', '2026-01-01', 0); // way too old
    seedAssetSnapshot(db, rel, 'card.js', '2026-06-21', 500);
    computeStatsCache(db, { asOfDate: '2026-06-21', nowIso: 'test' });
    const row = statsCache.getStatsCacheRow(db, r);
    // Only the today snapshot is in window → MIN within window = 500 = latest.
    // earliest_in_window == latest_in_window → delta = 0.
    expect(row?.total_downloads_30d).toBe(0);
  });
});

describe('computeStatsCache — latest stable release downloads', () => {
  it('picks the newest non-prerelease and uses the latest snapshot count', () => {
    const db = freshDb();
    const r = seedRepo(db, 'a', 'b', 'card.js');
    const v1 = seedRelease(db, r, 'v1');
    const v2 = seedRelease(db, r, 'v2');
    // v3 is a prerelease — must NOT win
    releases.upsertRelease(db, {
      repoId: r,
      tag: 'v3-pre',
      publishedAt: '2026-06-21T00:00:00Z',
      isPrerelease: true,
      htmlUrl: '',
    });
    // v2 is newer than v1 by published_at — should win the "latest" race
    db.raw
      .prepare('UPDATE releases SET published_at = ? WHERE id = ?')
      .run('2026-06-19T00:00:00Z', v1);
    db.raw
      .prepare('UPDATE releases SET published_at = ? WHERE id = ?')
      .run('2026-06-20T00:00:00Z', v2);
    seedAssetSnapshot(db, v1, 'card.js', '2026-06-21', 100);
    seedAssetSnapshot(db, v2, 'card.js', '2026-06-21', 850);
    computeStatsCache(db, { asOfDate: '2026-06-21', nowIso: 'test' });
    const row = statsCache.getStatsCacheRow(db, r);
    expect(row?.latest_release_tag).toBe('v2');
    expect(row?.latest_release_downloads).toBe(850);
  });

  it('honours hacs_filename — only the matching asset counts', () => {
    const db = freshDb();
    const r = seedRepo(db, 'a', 'b', 'card.js');
    const v1 = seedRelease(db, r, 'v1');
    seedAssetSnapshot(db, v1, 'card.js', '2026-06-21', 1500);
    seedAssetSnapshot(db, v1, 'source.zip', '2026-06-21', 9999); // must be ignored
    computeStatsCache(db, { asOfDate: '2026-06-21', nowIso: 'test' });
    expect(statsCache.getStatsCacheRow(db, r)?.latest_release_downloads).toBe(1500);
  });

  it('without hacs_filename, takes MAX across assets (Platinum-style icon-bundle case)', () => {
    const db = freshDb();
    const r = seedRepo(db, 'a', 'b'); // no hacs_filename
    const v1 = seedRelease(db, r, '1.0.5');
    // Like Platinum: 113 icon SVGs + the main JS, all roughly equal because
    // each install pulls the whole bundle.
    seedAssetSnapshot(db, v1, 'main.js', '2026-06-23', 55170);
    seedAssetSnapshot(db, v1, 'icon-a.svg', '2026-06-23', 55088);
    seedAssetSnapshot(db, v1, 'icon-b.svg', '2026-06-23', 55070);
    seedAssetSnapshot(db, v1, 'icon-c.svg', '2026-06-23', 55069);
    computeStatsCache(db, { asOfDate: '2026-06-23', nowIso: 'test' });
    // MAX(55170, 55088, 55070, 55069) = 55170. SUM would have been 220397.
    expect(statsCache.getStatsCacheRow(db, r)?.latest_release_downloads).toBe(55170);
  });

  it('returns null tag for a repo with only prereleases', () => {
    const db = freshDb();
    const r = seedRepo(db, 'a', 'b', 'card.js');
    releases.upsertRelease(db, {
      repoId: r,
      tag: 'v0.1.0-rc',
      publishedAt: '2026-06-20T00:00:00Z',
      isPrerelease: true,
      htmlUrl: '',
    });
    computeStatsCache(db, { asOfDate: '2026-06-21', nowIso: 'test' });
    const row = statsCache.getStatsCacheRow(db, r);
    expect(row?.latest_release_tag).toBeNull();
    expect(row?.latest_release_downloads).toBeNull();
  });
});

describe('computeStatsCache — stars', () => {
  it('produces correct 7d and 30d deltas from repo_star_history buckets', () => {
    const db = freshDb();
    const r = seedRepo(db, 'a', 'b');
    // 30d ago: 5 stars. Outside the 7d window, inside the 30d window.
    starHistory.upsertStarsAdded(db, r, '2026-05-22', 5);
    // 14d ago: 15 stars. Outside 7d, inside 30d.
    starHistory.upsertStarsAdded(db, r, '2026-06-07', 15);
    // 4d ago: 7 stars. Inside both windows.
    starHistory.upsertStarsAdded(db, r, '2026-06-17', 7);
    // Today: 3 stars. Inside both windows.
    starHistory.upsertStarsAdded(db, r, '2026-06-21', 3);
    computeStatsCache(db, { asOfDate: '2026-06-21', nowIso: 'test' });
    const row = statsCache.getStatsCacheRow(db, r);
    expect(row?.star_delta_7d).toBe(10); // 7 + 3
    expect(row?.star_delta_30d).toBe(30); // 5 + 15 + 7 + 3
  });

  it('day-1 (no star history): both deltas are 0', () => {
    const db = freshDb();
    const r = seedRepo(db, 'a', 'b');
    computeStatsCache(db, { asOfDate: '2026-06-21', nowIso: 'test' });
    const row = statsCache.getStatsCacheRow(db, r);
    expect(row?.star_delta_7d).toBe(0);
    expect(row?.star_delta_30d).toBe(0);
  });

  it('handles negative deltas (unstars) correctly', () => {
    const db = freshDb();
    const r = seedRepo(db, 'a', 'b');
    starHistory.upsertStarsAdded(db, r, '2026-06-20', 10);
    starHistory.upsertStarsAdded(db, r, '2026-06-21', -3); // unstar today
    computeStatsCache(db, { asOfDate: '2026-06-21', nowIso: 'test' });
    const row = statsCache.getStatsCacheRow(db, r);
    expect(row?.star_delta_7d).toBe(7);
    expect(row?.star_delta_30d).toBe(7);
  });
});

describe('computeStatsCache — coverage', () => {
  it('writes one row per repo, even repos with no releases or snapshots', () => {
    const db = freshDb();
    seedRepo(db, 'a', 'b');
    seedRepo(db, 'c', 'd');
    seedRepo(db, 'e', 'f');
    const res = computeStatsCache(db, { asOfDate: '2026-06-21', nowIso: 'test' });
    expect(res.rowsWritten).toBe(3);
    expect(statsCache.countStatsCacheRows(db)).toBe(3);
  });

  it('a re-run completely replaces the previous stats_cache', () => {
    const db = freshDb();
    const r = seedRepo(db, 'a', 'b');
    seedRepoSnapshot(db, r, '2026-06-21', 100);
    computeStatsCache(db, { asOfDate: '2026-06-21', nowIso: 'first' });
    // Add a second repo, re-run.
    seedRepo(db, 'c', 'd');
    computeStatsCache(db, { asOfDate: '2026-06-21', nowIso: 'second' });
    expect(statsCache.countStatsCacheRows(db)).toBe(2);
    const row = statsCache.getStatsCacheRow(db, r);
    expect(row?.updated_at).toBe('second');
  });
});
