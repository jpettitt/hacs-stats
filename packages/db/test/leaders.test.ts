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
  // Most tests assume the seeded repo shows up in leaderboards; since those
  // now filter to state='active', flip the row out of the migration's
  // default 'pending' as soon as it's seeded.
  const id = repos.upsertRepo(db, { owner, name, kind, source: 'default' });
  db.raw.prepare("UPDATE repos SET state = 'active' WHERE id = ?").run(id);
  return id;
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
    latest_release_tag?: string | null;
    latest_release_downloads?: number | null;
    latest_release_downloads_30d?: number | null;
    hot_release_tag_90d?: string | null;
    hot_release_downloads_90d?: number | null;
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
    latest_release_tag: opts.latest_release_tag ?? null,
    latest_release_downloads: opts.latest_release_downloads ?? null,
    latest_release_downloads_30d: opts.latest_release_downloads_30d ?? null,
    hot_release_tag_90d: opts.hot_release_tag_90d ?? null,
    hot_release_downloads_90d: opts.hot_release_downloads_90d ?? null,
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

  it('hides repos with no commit in 3+ years even when stars are high', () => {
    const db = freshDb();
    const stale = seedRepo(db, 'old', 'old');
    const fresh = seedRepo(db, 'new', 'new');
    const ancient = new Date(Date.now() - 4 * 365 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    // Stale repo has 9999 stars — would dominate the leaderboard if not
    // filtered. Stale-3y rule kicks in regardless of how popular it was.
    seedStats(db, stale, { stars: 9999, last_commit: ancient });
    seedStats(db, fresh, { stars: 1, last_commit: recent });
    const top = leaders.topByStars(db, 10);
    expect(top.map((r) => r.full_name)).toEqual(['new/new']);
  });
});

describe('leaders.trendingByStars', () => {
  it('only includes repos with positive 30-day star delta', () => {
    const db = freshDb();
    const a = seedRepo(db, 'a', 'a');
    const b = seedRepo(db, 'b', 'b');
    const c = seedRepo(db, 'c', 'c');
    seedStats(db, a, { stars: 100, star_delta_30d: 5 });
    seedStats(db, b, { stars: 50, star_delta_30d: 0 }); // not trending
    seedStats(db, c, { stars: 200, star_delta_30d: 20 });
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

  it('takes MAX across assets when hacs_filename is unset (not SUM)', () => {
    // Downloads are a proxy for installs — one install = one download of
    // the canonical asset. SUMing multiple assets would inflate the count
    // for repos that bundle e.g. icons + main file (each downloaded
    // alongside the install). MAX picks the dominant asset.
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
    // MAX(10, 25) = 25. SUM would have given 35.
    expect(rows[0]?.downloads).toBe(25);
  });
});

describe('repos.searchRepos (legacy)', () => {
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

describe('leaders.searchRepos (with sort + kind filter)', () => {
  it('defaults to name sort (case-insensitive, hacs_name preferred)', () => {
    const db = freshDb();
    const a = seedRepo(db, 'zoo', 'one'); // hacs_name "Apple"
    const b = seedRepo(db, 'aaa', 'two'); // hacs_name null → sorts by full_name 'aaa/two'
    const c = seedRepo(db, 'bee', 'three'); // hacs_name "Mango"
    repos.setHacsManifest(db, { fullName: 'zoo/one', hacsFilename: null, hacsName: 'Apple' });
    repos.setHacsManifest(db, { fullName: 'bee/three', hacsFilename: null, hacsName: 'Mango' });
    seedStats(db, a, { stars: 1 });
    seedStats(db, b, { stars: 1 });
    seedStats(db, c, { stars: 1 });

    const result = leaders.searchRepos(db, { q: '' });
    // Expect ordering: aaa/two (no hacs_name → full_name "aaa") < Apple < Mango.
    expect(result.rows.map((r) => r.full_name)).toEqual(['aaa/two', 'zoo/one', 'bee/three']);
    expect(result.total).toBe(3);
  });

  it('sort=stars orders by stars DESC', () => {
    const db = freshDb();
    const a = seedRepo(db, 'a', 'a');
    const b = seedRepo(db, 'b', 'b');
    const c = seedRepo(db, 'c', 'c');
    seedStats(db, a, { stars: 50 });
    seedStats(db, b, { stars: 500 });
    seedStats(db, c, { stars: 100 });
    const hits = leaders.searchRepos(db, { q: '', sort: 'stars' }).rows;
    expect(hits.map((r) => r.full_name)).toEqual(['b/b', 'c/c', 'a/a']);
  });

  it('sort=trending orders by 30-day star delta DESC (matches home Trending section)', () => {
    const db = freshDb();
    const a = seedRepo(db, 'a', 'a');
    const b = seedRepo(db, 'b', 'b');
    seedStats(db, a, { stars: 1, star_delta_30d: 3 });
    seedStats(db, b, { stars: 1, star_delta_30d: 42 });
    const hits = leaders.searchRepos(db, { q: '', sort: 'trending' }).rows;
    expect(hits.map((r) => r.full_name)).toEqual(['b/b', 'a/a']);
  });

  it('sort=downloads orders by latest_release_downloads DESC (new headline metric)', () => {
    const db = freshDb();
    const a = seedRepo(db, 'a', 'a');
    const b = seedRepo(db, 'b', 'b');
    seedStats(db, a, { stars: 1, latest_release_downloads: 100 });
    seedStats(db, b, { stars: 1, latest_release_downloads: 9999 });
    const hits = leaders.searchRepos(db, { q: '', sort: 'downloads' }).rows;
    expect(hits.map((r) => r.full_name)).toEqual(['b/b', 'a/a']);
    expect(hits[0]?.latest_release_downloads).toBe(9999);
  });

  it('sort=recent orders by latest.last_commit_at DESC', () => {
    const db = freshDb();
    const a = seedRepo(db, 'a', 'a');
    const b = seedRepo(db, 'b', 'b');
    seedStats(db, a, { stars: 1, last_commit: '2026-06-01T00:00:00Z' });
    seedStats(db, b, { stars: 1, last_commit: '2026-06-20T00:00:00Z' });
    const hits = leaders.searchRepos(db, { q: '', sort: 'recent' }).rows;
    expect(hits.map((r) => r.full_name)).toEqual(['b/b', 'a/a']);
  });

  it('kind filter narrows results to that category', () => {
    const db = freshDb();
    const a = seedRepo(db, 'a', 'a', 'plugin');
    const b = seedRepo(db, 'b', 'b', 'integration');
    const c = seedRepo(db, 'c', 'c', 'plugin');
    seedStats(db, a, { stars: 1 });
    seedStats(db, b, { stars: 1 });
    seedStats(db, c, { stars: 1 });
    const result = leaders.searchRepos(db, { q: '', kind: 'plugin' });
    expect(result.rows.map((r) => r.full_name).sort()).toEqual(['a/a', 'c/c']);
    expect(result.total).toBe(2);
  });

  it('q matches against full_name OR hacs_name OR description', () => {
    const db = freshDb();
    const a = seedRepo(db, 'piitaya', 'lovelace-mushroom');
    const b = seedRepo(db, 'noname', 'repo');
    const c = seedRepo(db, 'descr', 'iption');
    repos.setHacsManifest(db, {
      fullName: 'noname/repo',
      hacsFilename: null,
      hacsName: 'Mushroom Helper',
    });
    repos.updateRepoMetadata(db, {
      repoId: c,
      description: 'a mushroom helper',
      archived: false,
      defaultBranch: 'main',
    });
    seedStats(db, a, { stars: 1 });
    seedStats(db, b, { stars: 1 });
    seedStats(db, c, { stars: 1 });
    const hits = leaders.searchRepos(db, { q: 'mushroom' }).rows;
    expect(hits.map((r) => r.full_name).sort()).toEqual([
      'descr/iption',
      'noname/repo',
      'piitaya/lovelace-mushroom',
    ]);
  });

  it('escapes LIKE metacharacters in q', () => {
    const db = freshDb();
    const a = seedRepo(db, 'a', 'a');
    seedStats(db, a, { stars: 1 });
    // Plain `%` must not match every row.
    const result = leaders.searchRepos(db, { q: '%' });
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('combines q + kind + sort correctly', () => {
    const db = freshDb();
    const a = seedRepo(db, 'mushroom', 'one', 'plugin');
    const b = seedRepo(db, 'mushroom', 'two', 'plugin');
    const c = seedRepo(db, 'mushroom', 'three', 'integration');
    seedStats(db, a, { stars: 100 });
    seedStats(db, b, { stars: 500 });
    seedStats(db, c, { stars: 999 });
    const hits = leaders.searchRepos(db, {
      q: 'mushroom',
      kind: 'plugin',
      sort: 'stars',
    }).rows;
    expect(hits.map((r) => r.full_name)).toEqual(['mushroom/two', 'mushroom/one']);
  });

  it('paginates with limit + offset; total stays constant across pages', () => {
    const db = freshDb();
    for (let i = 0; i < 12; i++) {
      const id = seedRepo(db, 'owner', `repo${String(i).padStart(2, '0')}`);
      seedStats(db, id, { stars: 100 - i });
    }
    const p1 = leaders.searchRepos(db, { q: '', sort: 'stars', limit: 5, offset: 0 });
    const p2 = leaders.searchRepos(db, { q: '', sort: 'stars', limit: 5, offset: 5 });
    const p3 = leaders.searchRepos(db, { q: '', sort: 'stars', limit: 5, offset: 10 });
    expect(p1.rows.length).toBe(5);
    expect(p2.rows.length).toBe(5);
    expect(p3.rows.length).toBe(2);
    expect(p1.total).toBe(12);
    expect(p2.total).toBe(12);
    expect(p3.total).toBe(12);
    // No overlap, and stars descending across pages.
    const allStars = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.stars);
    expect(allStars).toEqual([...allStars].sort((a, b) => b - a));
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
