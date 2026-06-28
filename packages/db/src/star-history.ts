import type { Db } from './client.js';

/**
 * Per-day delta accumulator. ON CONFLICT adds rather than replaces — the
 * incremental scraper can record multiple deltas for the same day across
 * runs (e.g. when paging back catches stars dated today). Negative deltas
 * are allowed (see migration 0011 comment on unstar handling).
 */
export function upsertStarsAdded(db: Db, repoId: number, day: string, delta: number): void {
  db.raw
    .prepare(
      `INSERT INTO repo_star_history (repo_id, day, stars_added)
       VALUES (?, ?, ?)
       ON CONFLICT(repo_id, day) DO UPDATE
         SET stars_added = stars_added + excluded.stars_added`,
    )
    .run(repoId, day, delta);
}

/** Used by the scraper to decide whether to call /stargazers at all —
 * if our stored total equals GitHub's count there's nothing to fetch. */
export function totalStarsRecorded(db: Db, repoId: number): number {
  const row = db.raw
    .prepare<[number], { total: number | null }>(
      'SELECT SUM(stars_added) AS total FROM repo_star_history WHERE repo_id = ?',
    )
    .get(repoId);
  return row?.total ?? 0;
}

export interface StarHistoryPoint {
  /** 'YYYY-MM-DD' UTC. */
  day: string;
  /** Cumulative total stars at end of this day. */
  cumulative: number;
}

/**
 * Returns the cumulative star curve for one repo, oldest day first.
 * Uses a window function so we compute cumulative in SQL — for a 5y-old
 * repo with ~1500 daily buckets the whole query is sub-millisecond.
 * Caller slices to the desired display window (3y by convention).
 */
export function repoStarHistory(db: Db, repoId: number): StarHistoryPoint[] {
  return db.raw
    .prepare<[number], StarHistoryPoint>(
      `SELECT day,
              SUM(stars_added) OVER (ORDER BY day) AS cumulative
       FROM repo_star_history
       WHERE repo_id = ?
       ORDER BY day`,
    )
    .all(repoId);
}
