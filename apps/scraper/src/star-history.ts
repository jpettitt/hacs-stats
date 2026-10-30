/**
 * Per-day star history from GitHub's
 * GET /repos/{owner}/{repo}/stargazers/history.
 *
 * GitHub limited /stargazers (the per-star list this used to page) to
 * repo admins in July 2026; everyone else gets 404. This endpoint returns
 * counts only: `{week, total, days[7]}` entries, newest week first, 30
 * weeks per page, paged by `Link` (per_page is ignored). With a token each
 * page costs one REST `core` request.
 *
 * Bucketing (probed 2026-10-30 against the full /stargazers list of a repo
 * we admin): `week` is a Sunday at 00:00 UTC, but `days[i]` counts stars
 * on the US Pacific day `week + i`, DST included. We store those dates as
 * they come — the API gives no times to convert to UTC.
 *
 * Per repo:
 *   - never rebuilt (migration 0016) → fetch every page, replace all rows.
 *   - rebuilt and stored total == GitHub count → no-op, zero requests.
 *   - rebuilt and count changed → fetch page 1, replace the newest 30
 *     weeks. If older rows + page 1 don't sum to the live count (e.g. an
 *     unstar older than 30 weeks), rebuild in full.
 *
 * Full rebuilds draw pages from a budget shared across one run, so the
 * one-time move of ~6k repos spreads over several nights instead of
 * using up the REST quota the releases step needs.
 */
import { starHistory } from '@hacs-stats/db';
import type { Db } from '@hacs-stats/db';
import { type RateLimitGuard, observationFromRestHeaders } from './rate-limit.js';

const USER_AGENT = 'hacs-stats/0.0.0 (+https://hacs-stats.dev)';
const DAY_SEC = 86_400;

export interface StarHistoryWeek {
  /** Epoch seconds, Sunday 00:00 UTC. */
  week: number;
  total: number;
  days: number[];
}

export interface StarHistoryOptions {
  token?: string | undefined;
  /** Inject for tests. */
  fetchImpl?: typeof fetch;
  guard?: RateLimitGuard;
  /** Shared across repos in one run. Unset = unlimited. */
  budget?: { pagesLeft: number };
  /** Timestamp written to star_history_synced_at. Inject for tests. */
  now?: () => string;
}

export type StarHistorySyncResult =
  | { kind: 'no-op'; pages: 0 }
  | { kind: 'updated'; pages: number }
  | { kind: 'rebuilt'; pages: number }
  /** Needs a full rebuild, but the run's page budget can't cover it. */
  | { kind: 'deferred'; pages: number };

interface Page {
  weeks: StarHistoryWeek[];
  hasNext: boolean;
  /** From `Link: rel="last"`; null when absent (single page, or the last). */
  lastPage: number | null;
}

async function fetchPage(fullName: string, page: number, opts: StarHistoryOptions): Promise<Page> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const url = `https://api.github.com/repos/${fullName}/stargazers/history?page=${page}`;
  if (opts.guard) await opts.guard.waitIfNeeded();
  const res = await (opts.fetchImpl ?? fetch)(url, { headers });
  if (opts.guard) {
    const obs = observationFromRestHeaders(res.headers);
    if (obs) opts.guard.observe(obs);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`star history ${res.status} for ${fullName}: ${body.slice(0, 200)}`);
  }
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error(`star history for ${fullName}: body is not an array`);
  const link = res.headers.get('link') ?? '';
  const last = /[?&]page=(\d+)>;\s*rel="last"/.exec(link)?.[1];
  return {
    weeks: body as StarHistoryWeek[],
    hasNext: /rel="next"/.test(link),
    lastPage: last === undefined ? null : Number(last),
  };
}

/** Flatten weeks into 'YYYY-MM-DD' → stars. The date is plain calendar
 * arithmetic on the Sunday label — see the bucketing note above. */
export function weeksToDays(weeks: readonly StarHistoryWeek[]): Map<string, number> {
  const perDay = new Map<string, number>();
  for (const w of weeks) {
    w.days.forEach((n, i) => {
      const day = new Date((w.week + i * DAY_SEC) * 1000).toISOString().slice(0, 10);
      perDay.set(day, (perDay.get(day) ?? 0) + n);
    });
  }
  return perDay;
}

const sumValues = (m: ReadonlyMap<string, number>) => {
  let s = 0;
  for (const n of m.values()) s += n;
  return s;
};

/**
 * Bring one repo's history up to date. Throws on any HTTP failure without
 * writing anything; the caller counts and logs it, and the next run retries.
 */
export async function syncStarHistory(
  db: Db,
  repoId: number,
  fullName: string,
  currentStars: number,
  synced: boolean,
  opts: StarHistoryOptions = {},
): Promise<StarHistorySyncResult> {
  const budget = opts.budget ?? { pagesLeft: Number.POSITIVE_INFINITY };
  const now = opts.now ?? (() => new Date().toISOString());

  const rebuild = async (fetchedFirst: Page | null): Promise<StarHistorySyncResult> => {
    let page = fetchedFirst;
    let pages = page ? 1 : 0;
    if (!page) {
      if (budget.pagesLeft < 1) return { kind: 'deferred', pages };
      budget.pagesLeft--;
      page = await fetchPage(fullName, 1, opts);
      pages++;
    }
    // Check the whole cost up front when GitHub tells us the page count,
    // so a big repo doesn't spend half the budget and then give up.
    const remaining = page.hasNext ? (page.lastPage ?? 2) - 1 : 0;
    if (remaining > budget.pagesLeft) return { kind: 'deferred', pages };
    const weeks = [...page.weeks];
    for (let p = 2; page.hasNext; p++) {
      if (budget.pagesLeft < 1) return { kind: 'deferred', pages };
      budget.pagesLeft--;
      page = await fetchPage(fullName, p, opts);
      pages++;
      weeks.push(...page.weeks);
    }
    starHistory.replaceStarHistory(db, repoId, weeksToDays(weeks), null);
    starHistory.markStarHistorySynced(db, repoId, now());
    return { kind: 'rebuilt', pages };
  };

  if (!synced) return rebuild(null);
  if (starHistory.totalStarsRecorded(db, repoId) === currentStars)
    return { kind: 'no-op', pages: 0 };

  const first = await fetchPage(fullName, 1, opts);
  const perDay = weeksToDays(first.weeks);
  if (!first.hasNext) {
    // Page 1 is the repo's whole history.
    starHistory.replaceStarHistory(db, repoId, perDay, null);
    return { kind: 'updated', pages: 1 };
  }
  const oldest = first.weeks.reduce((m, w) => Math.min(m, w.week), Number.POSITIVE_INFINITY);
  const fromDay = new Date(oldest * 1000).toISOString().slice(0, 10);
  if (starHistory.starsRecordedBefore(db, repoId, fromDay) + sumValues(perDay) !== currentStars) {
    return rebuild(first);
  }
  starHistory.replaceStarHistory(db, repoId, perDay, fromDay);
  return { kind: 'updated', pages: 1 };
}
