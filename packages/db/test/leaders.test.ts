import { describe, expect, it } from 'vitest';
import {
  leaders,
  openDb,
  releases,
  repos,
  runMigrations,
  snapshots,
  statsCache,
} from '../src/index.js';

function freshDb() {
  const db = openDb({ path: ':memory:' });
  runMigrations(db);
  return db;
}

function seedRepo(
  db: ReturnType<typeof freshDb>,
  owner: string,
  name: string,
  kind: 'plugin' | 'integration' = 'plugin',
): number {
  return repos.upsertRepo(db, { owner, name, kind, source: 'default' });
}

function seedStats(
  db: ReturnType<typeof freshDb>,
  repoId: number,
  opts: {
    stars?: number;
    forks?: number;
    last_commit?: string | null;
    downloads_30d?: number;
    star_delta_7d?: number;
    star_delta_30d?: number;
    top_version_30d?: string | null;
    date?: string;
  },
) {
  const date = opts.date ?? '2026-06-22';
  snapshots.upsertRepoSnapshot(db, {
    repoId,
    snapshotDate: date,
    stars: opts.stars ?? 0,
    forks: opts.forks ?? 0,
    openIssues: 0,
    lastCommitAt: opts.last_commit ?? null,
  });
  statsCache.upsertStatsCacheRow(db, {
    repo_id: repoId,
    top_version_30d: opts.top_version_30d ?? null,
    top_version_downloads_30d: opts.downloads_30d ?? 0,
    total_downloads_30d: opts.downloads_30d ?? 0,
    star_delta_7d: opts.star_delta_7d ?? 0,
    star_delta_30d: opts.star_delta_30d ?? 0,
    updated_at: 'test',
  });
}

describe('leaders.topByStars', () => {
  it('orders by latest stars descending', () => {
    const db = freshDb();
    const a = seedRepo(db, 'a', 'a');
    const b = seedRepo(db, 'b', 'b');
    const c = seedRepo(db, 'c', 'c');
    seedStats(db, a, { stars: 100 });
    seedStats(db, b, { stars: 500 });
    seedStats(db, c, { stars: 250 });
    const top = leaders.topByStars(db, 10);
    expect(top.map((r) => r.full_name)).toEqual(['b/b', 'c/c', 'a/a']);
  });

  it('respects the limit parameter', () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) {
      const id = seedRepo(db, 'owner', `r${i}`);
      seedStats(db, id, { stars: i * 100 });
    }
    expect(leaders.topByStars(db, 3)).toHaveLength(3);
  });
});

describe('leaders.trendingByStars', () => {
  it('only includes repos with positive 7-day delta', () => {
    const db = freshDb();
    const a = seedRepo(db, 'a', 'a');
    const b = seedRepo(db, 'b', 'b');
    const c = seedRepo(db, 'c', 'c');
    seedStats(db, a, { stars: 100, star_delta_7d: 5 });
    seedStats(db, b, { stars: 50, star_delta_7d: 0 }); // not trending
    seedStats(db, c, { stars: 200, star_delta_7d: 20 });
    const t = leaders.trendingByStars(db, 10);
    expect(t.map((r) => r.full_name)).toEqual(['c/c', 'a/a']);
  });
});

describe('leaders.newArrivals + recentlyUpdated', () => {
  it('newArrivals orders by first_seen_at desc', () => {
    const db = freshDb();
    seedRepo(db, 'older', 'older');
    seedRepo(db, 'middle', 'middle');
    seedRepo(db, 'newest', 'newest');
    // upsertRepo stamps first_seen_at = now() on first insert; the second
    // call doesn't overwrite. So order is insert order, latest id wins.
    const r = leaders.newArrivals(db, 10);
    expect(r[0]?.full_name).toBe('newest/newest');
  });

  it('recentlyUpdated only includes repos with a last_commit_at', () => {
    const db = freshDb();
    const a = seedRepo(db, 'a', 'a');
    const b = seedRepo(db, 'b', 'b');
    seedStats(db, a, { last_commit: '2026-06-21T00:00:00Z' });
    seedStats(db, b, { last_commit: null });
    const r = leaders.recentlyUpdated(db, 10);
    expect(r.map((x) => x.full_name)).toEqual(['a/a']);
  });
});

describe('leaders.repoDetailByFullName', () => {
  it('returns null for unknown repo', () => {
    const db = freshDb();
    expect(leaders.repoDetailByFullName(db, 'no/such-repo')).toBeUndefined();
  });

  it('returns the joined detail row', () => {
    const db = freshDb();
    const id = seedRepo(db, 'me', 'thing', 'integration');
    seedStats(db, id, {
      stars: 42,
      star_delta_30d: 5,
      downloads_30d: 1234,
      top_version_30d: 'v1.0',
    });
    const d = leaders.repoDetailByFullName(db, 'me/thing');
    expect(d).toMatchObject({
      full_name: 'me/thing',
      kind: 'integration',
      stars: 42,
      star_delta_30d: 5,
      downloads_30d: 1234,
      top_version_30d: 'v1.0',
    });
  });
});

describe('leaders.repoStarsTimeseries', () => {
  it('returns daily stars in ascending date order, within window', () => {
    const db = freshDb();
    const id = seedRepo(db, 'a', 'a');
    snapshots.upsertRepoSnapshot(db, {
      repoId: id,
      snapshotDate: '2026-06-20',
      stars: 90,
      forks: 0,
      openIssues: 0,
      lastCommitAt: null,
    });
    snapshots.upsertRepoSnapshot(db, {
      repoId: id,
      snapshotDate: '2026-06-21',
      stars: 95,
      forks: 0,
      openIssues: 0,
      lastCommitAt: null,
    });
    snapshots.upsertRepoSnapshot(db, {
      repoId: id,
      snapshotDate: '2026-06-22',
      stars: 100,
      forks: 0,
      openIssues: 0,
      lastCommitAt: null,
    });
    const series = leaders.repoStarsTimeseries(db, id, 365);
    expect(series.map((p) => p.stars)).toEqual([90, 95, 100]);
  });
});

describe('leaders.releaseDownloadsForRepo', () => {
  it('respects hacs_filename when set (only that asset counts)', () => {
    const db = freshDb();
    const id = seedRepo(db, 'me', 'thing');
    repos.setHacsFilename(db, { fullName: 'me/thing', hacsFilename: 'card.js' });
    const rel = releases.upsertRelease(db, {
      repoId: id,
      tag: 'v1',
      publishedAt: '2026-06-21T00:00:00Z',
      isPrerelease: false,
      htmlUrl: 'https://example/v1',
    });
    releases.upsertReleaseAssetSnapshot(db, {
      releaseId: rel,
      assetName: 'card.js',
      snapshotDate: '2026-06-22',
      downloadCount: 1000,
    });
    releases.upsertReleaseAssetSnapshot(db, {
      releaseId: rel,
      assetName: 'source.tar.gz',
      snapshotDate: '2026-06-22',
      downloadCount: 9999, // must be ignored
    });
    const rows = leaders.releaseDownloadsForRepo(db, id, 10);
    expect(rows).toEqual([
      {
        tag: 'v1',
        published_at: '2026-06-21T00:00:00Z',
        is_prerelease: 0,
        html_url: 'https://example/v1',
        downloads: 1000,
      },
    ]);
  });

  it('sums all assets when hacs_filename is unset', () => {
    const db = freshDb();
    const id = seedRepo(db, 'me', 'thing');
    // No setHacsFilename.
    const rel = releases.upsertRelease(db, {
      repoId: id,
      tag: 'v1',
      publishedAt: '2026-06-21T00:00:00Z',
      isPrerelease: false,
      htmlUrl: 'https://example/v1',
    });
    releases.upsertReleaseAssetSnapshot(db, {
      releaseId: rel,
      assetName: 'a',
      snapshotDate: '2026-06-22',
      downloadCount: 10,
    });
    releases.upsertReleaseAssetSnapshot(db, {
      releaseId: rel,
      assetName: 'b',
      snapshotDate: '2026-06-22',
      downloadCount: 25,
    });
    const rows = leaders.releaseDownloadsForRepo(db, id, 10);
    expect(rows[0]?.downloads).toBe(35);
  });
});

describe('repos.searchRepos', () => {
  it('finds matches by full_name substring', () => {
    const db = freshDb();
    seedRepo(db, 'piitaya', 'lovelace-mushroom');
    seedRepo(db, 'Clooos', 'Bubble-Card');
    expect(repos.searchRepos(db, 'mushroom').map((r) => r.full_name)).toEqual([
      'piitaya/lovelace-mushroom',
    ]);
  });

  it('escapes LIKE metacharacters in user input', () => {
    const db = freshDb();
    seedRepo(db, 'foo', 'normal');
    // User typed a % — must not match every row.
    expect(repos.searchRepos(db, '%').map((r) => r.full_name)).toEqual([]);
  });
});

describe('repos.categoryCounts', () => {
  it('groups by kind, sorts by count desc', () => {
    const db = freshDb();
    seedRepo(db, 'a', '1', 'plugin');
    seedRepo(db, 'a', '2', 'plugin');
    seedRepo(db, 'a', '3', 'integration');
    expect(repos.categoryCounts(db)).toEqual([
      { kind: 'plugin', n: 2 },
      { kind: 'integration', n: 1 },
    ]);
  });
});
