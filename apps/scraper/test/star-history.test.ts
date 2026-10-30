import { readFileSync } from 'node:fs';
import { type Db, openDb, repos, runMigrations, starHistory } from '@hacs-stats/db';
import { describe, expect, it } from 'vitest';
import { type StarHistoryWeek, syncStarHistory, weeksToDays } from '../src/star-history.js';

interface Fixture {
  stargazersCount: number;
  pages: Record<string, { link: string | null; body: StarHistoryWeek[] }>;
}

// Real responses captured from GitHub — see the file's _comment.
const FIXTURES = JSON.parse(
  readFileSync(new URL('./fixtures/star-history.json', import.meta.url), 'utf8'),
) as { repos: Record<string, Fixture> };
const BLUEAIR = FIXTURES.repos['dahlb/ha_blueair'] as Fixture; // 8 pages, 125 stars
const ZERO = FIXTURES.repos['njongai/HAC-Australia'] as Fixture; // 1 page, 0 stars

function freshDb(): Db {
  const db = openDb({ path: ':memory:' });
  runMigrations(db);
  return db;
}

function seedRepo(db: Db): number {
  return repos.upsertRepo(db, { owner: 'o', name: 'r', kind: 'plugin', source: 'default' });
}

/** Replays a fixture by `?page=N`, with its real Link header. */
function serve(fx: Fixture) {
  const pagesRequested: number[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    const page = Number(new URL(String(url)).searchParams.get('page'));
    pagesRequested.push(page);
    const p = fx.pages[String(page)];
    const headers = new Headers(p?.link ? { link: p.link } : {});
    return new Response(JSON.stringify(p?.body ?? []), { status: 200, headers });
  };
  return { fetchImpl, pagesRequested };
}

const total = (fx: Fixture) =>
  Object.values(fx.pages).reduce((s, p) => s + p.body.reduce((t, w) => t + w.total, 0), 0);

const isSynced = (db: Db, id: number) => starHistory.syncedRepoIds(db).has(id);

describe('weeksToDays', () => {
  it('maps days[i] to the calendar day week + i', () => {
    // 1792886400 = Sunday 2026-10-25 00:00 UTC.
    const days = weeksToDays([{ week: 1792886400, total: 3, days: [1, 0, 0, 0, 0, 2, 0] }]);
    expect(days.get('2026-10-25')).toBe(1);
    expect(days.get('2026-10-30')).toBe(2);
    expect([...days.values()].reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe('syncStarHistory — full rebuild', () => {
  it('replaces old rows with the whole history and marks the repo synced', async () => {
    const db = freshDb();
    const id = seedRepo(db);
    // Old UTC rows from the /stargazers era, frozen short of the real count.
    starHistory.upsertStarsAdded(db, id, '2022-07-19', 1);
    starHistory.upsertStarsAdded(db, id, '2026-07-03', 111);
    const { fetchImpl, pagesRequested } = serve(BLUEAIR);
    const budget = { pagesLeft: 100 };

    const r = await syncStarHistory(db, id, 'o/r', BLUEAIR.stargazersCount, false, {
      fetchImpl,
      budget,
    });

    expect(r).toEqual({ kind: 'rebuilt', pages: 8 });
    expect(pagesRequested).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(budget.pagesLeft).toBe(92);
    expect(starHistory.totalStarsRecorded(db, id)).toBe(BLUEAIR.stargazersCount);
    // Every stored day is one GitHub reported; none of the old rows survive.
    const expected = weeksToDays(Object.values(BLUEAIR.pages).flatMap((p) => p.body));
    for (const p of starHistory.repoStarHistory(db, id)) expect(expected.has(p.day)).toBe(true);
    expect(isSynced(db, id)).toBe(true);
  });

  it('handles a 0-star repo (one page, no Link header)', async () => {
    const db = freshDb();
    const id = seedRepo(db);
    const r = await syncStarHistory(db, id, 'o/r', 0, false, serve(ZERO));
    expect(r).toEqual({ kind: 'rebuilt', pages: 1 });
    expect(starHistory.repoStarHistory(db, id)).toEqual([]);
    expect(isSynced(db, id)).toBe(true);
  });

  it('defers without writing when the budget cannot cover every page', async () => {
    const db = freshDb();
    const id = seedRepo(db);
    starHistory.upsertStarsAdded(db, id, '2026-07-03', 111);
    const { fetchImpl, pagesRequested } = serve(BLUEAIR);
    const budget = { pagesLeft: 5 };

    const r = await syncStarHistory(db, id, 'o/r', 125, false, { fetchImpl, budget });

    // Page 1 told us there are 8; 7 more don't fit in 4.
    expect(r).toEqual({ kind: 'deferred', pages: 1 });
    expect(pagesRequested).toEqual([1]);
    expect(budget.pagesLeft).toBe(4);
    expect(starHistory.totalStarsRecorded(db, id)).toBe(111);
    expect(isSynced(db, id)).toBe(false);
  });

  it('makes no request when the budget is empty', async () => {
    const db = freshDb();
    const id = seedRepo(db);
    const { fetchImpl, pagesRequested } = serve(BLUEAIR);
    const r = await syncStarHistory(db, id, 'o/r', 125, false, {
      fetchImpl,
      budget: { pagesLeft: 0 },
    });
    expect(r).toEqual({ kind: 'deferred', pages: 0 });
    expect(pagesRequested).toEqual([]);
  });
});

describe('syncStarHistory — synced repos', () => {
  async function syncedDb() {
    const db = freshDb();
    const id = seedRepo(db);
    await syncStarHistory(db, id, 'o/r', 125, false, serve(BLUEAIR));
    return { db, id };
  }

  it('is a no-op with zero requests when the count is unchanged', async () => {
    const { db, id } = await syncedDb();
    const { fetchImpl, pagesRequested } = serve(BLUEAIR);
    const r = await syncStarHistory(db, id, 'o/r', 125, true, { fetchImpl });
    expect(r).toEqual({ kind: 'no-op', pages: 0 });
    expect(pagesRequested).toEqual([]);
  });

  it('fetches only page 1 for new stars and keeps older rows', async () => {
    const { db, id } = await syncedDb();
    const page8Before = starHistory.repoStarHistory(db, id).filter((p) => p.day < '2023-01-01');
    // GitHub later: two new stars on Friday of the newest week.
    const later = structuredClone(BLUEAIR);
    const newest = later.pages['1']?.body[0] as StarHistoryWeek;
    newest.days[5] = (newest.days[5] ?? 0) + 2;
    newest.total += 2;
    const { fetchImpl, pagesRequested } = serve(later);
    const budget = { pagesLeft: 100 };

    const r = await syncStarHistory(db, id, 'o/r', 127, true, { fetchImpl, budget });

    expect(r).toEqual({ kind: 'updated', pages: 1 });
    expect(pagesRequested).toEqual([1]);
    expect(budget.pagesLeft).toBe(100); // updates don't draw on the rebuild budget
    expect(starHistory.totalStarsRecorded(db, id)).toBe(127);
    expect(starHistory.repoStarHistory(db, id).filter((p) => p.day < '2023-01-01')).toEqual(
      page8Before,
    );
  });

  it('rebuilds in full when an old unstar makes page 1 not add up', async () => {
    const { db, id } = await syncedDb();
    // GitHub later: someone unstarred a 2022 star. Page 1 is unchanged.
    const later = structuredClone(BLUEAIR);
    const oldWeek = later.pages['8']?.body.find((w) => w.total > 0) as StarHistoryWeek;
    const i = oldWeek.days.findIndex((n) => n > 0);
    oldWeek.days[i] = (oldWeek.days[i] ?? 0) - 1;
    oldWeek.total -= 1;
    expect(total(later)).toBe(124);
    const { fetchImpl, pagesRequested } = serve(later);

    const r = await syncStarHistory(db, id, 'o/r', 124, true, { fetchImpl });

    expect(r).toEqual({ kind: 'rebuilt', pages: 8 });
    expect(pagesRequested).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // page 1 is not fetched twice
    expect(starHistory.totalStarsRecorded(db, id)).toBe(124);
  });
});

describe('syncStarHistory — requests and failures', () => {
  it('sends the token and API version to the history endpoint', async () => {
    const db = freshDb();
    const id = seedRepo(db);
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      seen = { url: String(url), headers: init?.headers as Record<string, string> };
      return new Response('[]', { status: 200 });
    };
    await syncStarHistory(db, id, 'dahlb/ha_blueair', 0, false, { fetchImpl, token: 'tok' });
    expect(seen?.url).toBe(
      'https://api.github.com/repos/dahlb/ha_blueair/stargazers/history?page=1',
    );
    expect(seen?.headers.Authorization).toBe('Bearer tok');
    expect(seen?.headers['X-GitHub-Api-Version']).toBe('2026-03-10');
  });

  it('throws on a 404 and leaves the stored history alone', async () => {
    const db = freshDb();
    const id = seedRepo(db);
    starHistory.upsertStarsAdded(db, id, '2026-07-03', 111);
    const fetchImpl: typeof fetch = async () =>
      new Response(
        '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/activity/starring#get-repository-star-history","status":"404"}',
        { status: 404 },
      );
    await expect(syncStarHistory(db, id, 'o/r', 125, false, { fetchImpl })).rejects.toThrow(
      /star history 404 for o\/r/,
    );
    expect(starHistory.totalStarsRecorded(db, id)).toBe(111);
    expect(isSynced(db, id)).toBe(false);
  });

  it('throws on a failure mid-rebuild without writing a partial history', async () => {
    const db = freshDb();
    const id = seedRepo(db);
    starHistory.upsertStarsAdded(db, id, '2026-07-03', 111);
    const { fetchImpl: real } = serve(BLUEAIR);
    const fetchImpl: typeof fetch = async (url, init) =>
      String(url).endsWith('page=5') ? new Response('', { status: 502 }) : real(url, init);
    await expect(syncStarHistory(db, id, 'o/r', 125, false, { fetchImpl })).rejects.toThrow(/502/);
    expect(starHistory.totalStarsRecorded(db, id)).toBe(111);
  });
});
