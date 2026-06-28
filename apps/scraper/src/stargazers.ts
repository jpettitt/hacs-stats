/**
 * Build per-day star-history for one repo from GitHub's /stargazers
 * endpoint.
 *
 * Algorithm:
 *
 *   1. Compare GitHub's current stargazer count (already fetched via
 *      GraphQL in step 2 of the scrape) to our stored cumulative.
 *
 *   2. If equal → no-op. The most common case, especially for the
 *      long tail of low-velocity repos. Zero REST calls.
 *
 *   3. If GitHub > ours by N (the typical "we gained stars" case): page
 *      backward from the last page of /stargazers (most recent stars
 *      first), bucket each `starred_at` by UTC day, until N entries
 *      have been collected OR until we hit the per-scrape page cap.
 *      The cap is critical: a never-tracked repo with 40k stars would
 *      otherwise burn 400 REST calls in one scrape. Bounded, the
 *      backfill spreads across multiple nights.
 *
 *   4. If GitHub < ours (unstar): we can't tell which day the unstar
 *      came from, so we record a negative delta on today. The
 *      cumulative curve stays accurate; the per-day delta chart has a
 *      one-day blip.
 *
 * GitHub note: /stargazers caps at 40,000 most-recent stars for
 * unauthenticated requests. We're always authenticated, so no cap
 * applies. Pagination is in star-time order (oldest first by default,
 * newest first via page=LAST).
 */
import { starHistory } from '@hacs-stats/db';
import type { Db } from '@hacs-stats/db';

const USER_AGENT = 'hacs-stats/0.0.0 (+https://hacs-stats.dev)';
const STAR_MEDIA_TYPE = 'application/vnd.github.v3.star+json';

export interface FetchStarHistoryOptions {
  token: string;
  /** Hard upper bound on pages fetched for ONE repo in ONE scrape. The
   * default 20 = 2000 stars per repo per night, so a never-tracked 10k-star
   * repo fully backfills over 5 nights. Override via env in the scrape
   * orchestrator. */
  maxPagesPerScrape?: number;
  /** Inject for tests. */
  fetchImpl?: typeof fetch;
  /** UTC date string to bucket unstars against. Default = today. Tests
   * pin it to keep assertions deterministic. */
  nowDay?: string;
}

export interface FetchStarHistoryResult {
  /** GitHub stars at scrape time (the value we were given). */
  currentStars: number;
  /** Our recorded sum before this update. */
  storedBefore: number;
  /** New stars (or negative for unstars) recorded into history. */
  deltaApplied: number;
  /** REST pages fetched. 0 means we skipped (no delta). */
  pagesFetched: number;
  /** True when delta > 0 and we hit the per-scrape cap before catching
   * up. The remaining stars come in on subsequent scrapes. */
  truncatedByCap: boolean;
}

interface StargazerEntry {
  starred_at?: string;
}

/**
 * Bring repo's star history up to date with `currentStars`. Returns a
 * structured result instead of logging — the caller aggregates across
 * the catalog and emits one summary line.
 */
export async function fetchAndStoreStarHistory(
  db: Db,
  repoId: number,
  fullName: string,
  currentStars: number,
  opts: FetchStarHistoryOptions,
): Promise<FetchStarHistoryResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxPages = opts.maxPagesPerScrape ?? 20;
  const nowDay = opts.nowDay ?? new Date().toISOString().slice(0, 10);

  const storedBefore = starHistory.totalStarsRecorded(db, repoId);
  const delta = currentStars - storedBefore;

  if (delta === 0) {
    return { currentStars, storedBefore, deltaApplied: 0, pagesFetched: 0, truncatedByCap: false };
  }

  if (delta < 0) {
    // Unstar(s). Best we can do is debit today; cumulative still ends
    // at currentStars after this bucket.
    starHistory.upsertStarsAdded(db, repoId, nowDay, delta);
    return {
      currentStars,
      storedBefore,
      deltaApplied: delta,
      pagesFetched: 0,
      truncatedByCap: false,
    };
  }

  // delta > 0 — page backward collecting timestamps. We bucket per-day
  // in memory first and write once at the end so multiple stars on the
  // same UTC day collapse into a single UPSERT.
  const perDay = new Map<string, number>();
  const lastPage = Math.max(1, Math.ceil(currentStars / 100));
  let collected = 0;
  let pagesFetched = 0;
  let truncatedByCap = false;

  for (let page = lastPage; page >= 1 && collected < delta; page--) {
    if (pagesFetched >= maxPages) {
      truncatedByCap = true;
      break;
    }
    const url = `https://api.github.com/repos/${fullName}/stargazers?per_page=100&page=${page}`;
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'User-Agent': USER_AGENT,
        Accept: STAR_MEDIA_TYPE,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    pagesFetched++;
    if (!res.ok) {
      // Soft-fail: rate limit, transient 5xx, repo went private mid-
      // scrape. We've recorded what we have so far; next scrape retries.
      break;
    }
    const body = (await res.json()) as StargazerEntry[];
    // Page is ordered oldest-first within itself even when we ask for
    // the last page; iterate in reverse so we collect newest-first and
    // can stop as soon as we've covered the delta.
    for (let i = body.length - 1; i >= 0 && collected < delta; i--) {
      const ts = body[i]?.starred_at;
      if (typeof ts !== 'string') continue;
      const day = ts.slice(0, 10); // 'YYYY-MM-DD' UTC
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
      collected++;
    }
  }

  if (perDay.size > 0) {
    const tx = db.raw.transaction(() => {
      for (const [day, count] of perDay) {
        starHistory.upsertStarsAdded(db, repoId, day, count);
      }
    });
    tx();
  }

  return {
    currentStars,
    storedBefore,
    deltaApplied: collected,
    pagesFetched,
    truncatedByCap,
  };
}
