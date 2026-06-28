import { type Db, openDb, repos, runMigrations, snapshots, starHistory } from '@hacs-stats/db';
import { describe, expect, it } from 'vitest';
import { fetchAndStoreStarHistory } from '../src/stargazers.js';

function freshDb(): Db {
  const db = openDb({ path: ':memory:' });
  runMigrations(db);
  return db;
}

function seedRepo(db: Db, owner: string, name: string): number {
  const id = repos.upsertRepo(db, { owner, name, kind: 'plugin', source: 'default' });
  // Flip out of pending so leader queries that filter ACTIVE_ONLY can see it
  // — irrelevant here but keeps DB consistent for follow-up assertions.
  db.raw.prepare("UPDATE repos SET state = 'active' WHERE id = ?").run(id);
  return id;
}

/** Build a /stargazers page payload: `n` entries with starred_at evenly
 * spaced across `[startIso, endIso]`. Returns array sized to per_page. */
function makePage(starredAts: string[]): Array<{ starred_at: string }> {
  return starredAts.map((s) => ({ starred_at: s }));
}

describe('fetchAndStoreStarHistory', () => {
  it('no-op when stored sum equals currentStars', async () => {
    const db = freshDb();
    const id = seedRepo(db, 'a', 'a');
    // Pre-seed history so stored sum matches.
    starHistory.upsertStarsAdded(db, id, '2025-01-01', 100);

    const fetchImpl: typeof fetch = async () => {
      throw new Error('fetch should NOT be called when delta=0');
    };
    const r = await fetchAndStoreStarHistory(db, id, 'a/a', 100, {
      token: 't',
      fetchImpl,
    });
    expect(r).toEqual({
      currentStars: 100,
      storedBefore: 100,
      deltaApplied: 0,
      pagesFetched: 0,
      truncatedByCap: false,
    });
  });

  it('records a negative delta on today when GitHub count drops (unstar)', async () => {
    const db = freshDb();
    const id = seedRepo(db, 'a', 'a');
    starHistory.upsertStarsAdded(db, id, '2025-01-01', 100);

    const fetchImpl: typeof fetch = async () => {
      throw new Error('fetch should NOT be called on negative delta');
    };
    const r = await fetchAndStoreStarHistory(db, id, 'a/a', 97, {
      token: 't',
      fetchImpl,
      nowDay: '2026-06-27',
    });
    expect(r.deltaApplied).toBe(-3);
    expect(starHistory.totalStarsRecorded(db, id)).toBe(97);
  });

  it('pages backward from the last page when delta is small', async () => {
    const db = freshDb();
    const id = seedRepo(db, 'a', 'a');
    // Pre-seed: 8 stars already recorded.
    starHistory.upsertStarsAdded(db, id, '2025-12-01', 8);

    // GitHub says 10 stars now — page=1 is the last page (since 10/100=1).
    // We expect ONE fetch for page=1 returning all 10 entries (the entries
    // are oldest-first within a page; iterating in reverse we collect the
    // newest 2 first and stop at delta=2).
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify(
          makePage([
            // oldest first within page
            ...Array.from({ length: 8 }, (_, i) => `2025-12-01T0${i}:00:00Z`),
            '2026-01-01T00:00:00Z',
            '2026-01-02T00:00:00Z',
          ]),
        ),
      );
    };
    const r = await fetchAndStoreStarHistory(db, id, 'a/a', 10, {
      token: 't',
      fetchImpl,
    });
    expect(r.deltaApplied).toBe(2);
    expect(r.pagesFetched).toBe(1);
    expect(calls[0]).toContain('page=1');
    expect(starHistory.totalStarsRecorded(db, id)).toBe(10);
    // The two new stars landed on Jan 1 and Jan 2.
    const series = starHistory.repoStarHistory(db, id);
    const jan1 = series.find((p) => p.day === '2026-01-01');
    const jan2 = series.find((p) => p.day === '2026-01-02');
    expect(jan1).toBeDefined();
    expect(jan2).toBeDefined();
  });

  it('walks multiple pages backward when delta spans pages', async () => {
    const db = freshDb();
    const id = seedRepo(db, 'a', 'a');
    // Stored: 0. Current: 250 → delta=250, page count=3 (page 1 has 100,
    // page 2 has 100, page 3 has 50).
    const pageHits: number[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      const m = /[?&]page=(\d+)/.exec(String(url));
      const page = Number(m?.[1]);
      pageHits.push(page);
      // 50 entries on page 3 (the last), 100 each on pages 1 and 2.
      const count = page === 3 ? 50 : 100;
      const day = page === 3 ? '2026-06-20' : page === 2 ? '2026-06-15' : '2026-06-10';
      return new Response(
        JSON.stringify(makePage(Array.from({ length: count }, () => `${day}T00:00:00Z`))),
      );
    };
    const r = await fetchAndStoreStarHistory(db, id, 'a/a', 250, {
      token: 't',
      fetchImpl,
    });
    expect(r.pagesFetched).toBe(3);
    expect(pageHits).toEqual([3, 2, 1]); // backward
    expect(r.deltaApplied).toBe(250);
    expect(starHistory.totalStarsRecorded(db, id)).toBe(250);
  });

  it('stops at maxPagesPerScrape and reports truncatedByCap', async () => {
    const db = freshDb();
    const id = seedRepo(db, 'a', 'a');
    // Stored 0, current 1000 → delta needs 10 pages. Cap at 3.
    const pageHits: number[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      const page = Number(/[?&]page=(\d+)/.exec(String(url))?.[1]);
      pageHits.push(page);
      return new Response(
        JSON.stringify(makePage(Array.from({ length: 100 }, () => '2026-01-01T00:00:00Z'))),
      );
    };
    const r = await fetchAndStoreStarHistory(db, id, 'a/a', 1000, {
      token: 't',
      fetchImpl,
      maxPagesPerScrape: 3,
    });
    expect(r.pagesFetched).toBe(3);
    expect(r.truncatedByCap).toBe(true);
    expect(r.deltaApplied).toBe(300);
    // Next scrape (same currentStars) will see delta=700 and walk more.
    expect(starHistory.totalStarsRecorded(db, id)).toBe(300);
  });

  it('soft-fails on non-OK responses without throwing', async () => {
    const db = freshDb();
    const id = seedRepo(db, 'a', 'a');
    const fetchImpl: typeof fetch = async () => new Response('rate limit', { status: 403 });
    const r = await fetchAndStoreStarHistory(db, id, 'a/a', 50, {
      token: 't',
      fetchImpl,
    });
    expect(r.pagesFetched).toBe(1);
    expect(r.deltaApplied).toBe(0);
    expect(starHistory.totalStarsRecorded(db, id)).toBe(0);
  });

  it('integrates with snapshots: cumulative line matches stargazerCount when caught up', async () => {
    const db = freshDb();
    const id = seedRepo(db, 'a', 'a');
    // Simulate a snapshot existing so the rest of the system still
    // works alongside the new table.
    snapshots.upsertRepoSnapshot(db, {
      repoId: id,
      snapshotDate: '2026-06-27',
      stars: 5,
      forks: 0,
      openIssues: 0,
      lastCommitAt: null,
    });
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify(
          makePage([
            '2026-06-25T00:00:00Z',
            '2026-06-25T01:00:00Z',
            '2026-06-26T00:00:00Z',
            '2026-06-26T01:00:00Z',
            '2026-06-27T00:00:00Z',
          ]),
        ),
      );
    await fetchAndStoreStarHistory(db, id, 'a/a', 5, {
      token: 't',
      fetchImpl,
    });
    const series = starHistory.repoStarHistory(db, id);
    expect(series).toEqual([
      { day: '2026-06-25', cumulative: 2 },
      { day: '2026-06-26', cumulative: 4 },
      { day: '2026-06-27', cumulative: 5 },
    ]);
  });
});
