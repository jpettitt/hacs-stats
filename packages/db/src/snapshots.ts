import type { Db } from './client.js';

export interface UpsertRepoSnapshotInput {
  repoId: number;
  snapshotDate: string; // YYYY-MM-DD (UTC)
  stars: number;
  forks: number;
  openIssues: number;
  lastCommitAt: string | null;
}

/**
 * Same-day re-runs OVERWRITE the snapshot — by design. A scrape that re-runs
 * later in the day should refresh today's row rather than create a duplicate
 * (PK is (repo_id, snapshot_date) so a duplicate would error anyway).
 */
export function upsertRepoSnapshot(db: Db, input: UpsertRepoSnapshotInput): void {
  db.raw
    .prepare(`
      INSERT INTO repo_snapshots
        (repo_id, snapshot_date, stars, forks, open_issues, last_commit_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, snapshot_date) DO UPDATE SET
        stars          = excluded.stars,
        forks          = excluded.forks,
        open_issues    = excluded.open_issues,
        last_commit_at = excluded.last_commit_at
    `)
    .run(
      input.repoId,
      input.snapshotDate,
      input.stars,
      input.forks,
      input.openIssues,
      input.lastCommitAt,
    );
}

export function countSnapshotsForDate(db: Db, snapshotDate: string): number {
  const row = db.raw
    .prepare<[string], { n: number }>(
      'SELECT COUNT(*) AS n FROM repo_snapshots WHERE snapshot_date = ?',
    )
    .get(snapshotDate);
  return row?.n ?? 0;
}
