import type { Db } from './client.js';

/**
 * Per-day delta accumulator. ON CONFLICT adds rather than replaces.
 * Production writes go through `replaceStarHistory`; this stays for test
 * setup, where adding one bucket at a time reads better.
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

/** Used by the scraper to decide whether to fetch at all — if our stored
 * total equals GitHub's count there's nothing new. */
export function totalStarsRecorded(db: Db, repoId: number): number {
  const row = db.raw
    .prepare<[number], { total: number | null }>(
      'SELECT SUM(stars_added) AS total FROM repo_star_history WHERE repo_id = ?',
    )
    .get(repoId);
  return row?.total ?? 0;
}

/** Stars recorded on days strictly before `day`. */
export function starsRecordedBefore(db: Db, repoId: number, day: string): number {
  const row = db.raw
    .prepare<[number, string], { total: number | null }>(
      'SELECT SUM(stars_added) AS total FROM repo_star_history WHERE repo_id = ? AND day < ?',
    )
    .get(repoId, day);
  return row?.total ?? 0;
}

/**
 * Replace a repo's buckets from `fromDay` onward (all of them when
 * `fromDay` is null) with `perDay`. Zero-count days are not stored.
 * One transaction, so a reader never sees the history half-replaced.
 */
export function replaceStarHistory(
  db: Db,
  repoId: number,
  perDay: ReadonlyMap<string, number>,
  fromDay: string | null,
): void {
  const ins = db.raw.prepare<[number, string, number]>(
    'INSERT INTO repo_star_history (repo_id, day, stars_added) VALUES (?, ?, ?)',
  );
  db.raw.transaction(() => {
    if (fromDay === null) {
      db.raw.prepare('DELETE FROM repo_star_history WHERE repo_id = ?').run(repoId);
    } else {
      db.raw
        .prepare('DELETE FROM repo_star_history WHERE repo_id = ? AND day >= ?')
        .run(repoId, fromDay);
    }
    for (const [day, n] of perDay) {
      if (n !== 0) ins.run(repoId, day, n);
    }
  })();
}

/** Repos whose history was rebuilt from the per-day endpoint (migration 0016). */
export function syncedRepoIds(db: Db): Set<number> {
  const rows = db.raw
    .prepare<[], { id: number }>('SELECT id FROM repos WHERE star_history_synced_at IS NOT NULL')
    .all();
  return new Set(rows.map((r) => r.id));
}

export function markStarHistorySynced(db: Db, repoId: number, at: string): void {
  db.raw.prepare('UPDATE repos SET star_history_synced_at = ? WHERE id = ?').run(at, repoId);
}

export interface StarHistoryPoint {
  /** 'YYYY-MM-DD'. US Pacific day for rows from the per-day endpoint, UTC
   * for rows from the old /stargazers path (see migration 0016). */
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
