import type { Db } from '@hacs-stats/db';

/**
 * Collapse old daily snapshots to one row per ISO week.
 *
 * Rationale: per-day granularity is useful for the most recent window (so
 * the dashboard's 30-day delta is accurate), but every older day is wasted
 * disk + slower queries. Once the data is past the "we'll subtract it"
 * window, weekly resolution is plenty for long-term trend charts.
 *
 * For each (repo_id, ISO-week) older than `keepDailyDays`, we keep ONLY the
 * most recent snapshot_date in that week — every other row in the week is
 * deleted. The latest-in-week choice means a Sunday-evening snapshot wins
 * over Monday-morning data when collapsing, which keeps the values fresh.
 */
export interface RetentionResult {
  repoSnapshotsDeleted: number;
  assetSnapshotsDeleted: number;
  durationSec: number;
}

export interface ApplyRetentionOptions {
  /** Override "today" — tests pin this against seeded data. */
  asOfDate?: string;
  /** Keep daily resolution for snapshots this recent. Default 90 days. */
  repoSnapshotsKeepDailyDays?: number;
  /** Keep daily resolution for asset snapshots this recent. Default 30 days. */
  assetSnapshotsKeepDailyDays?: number;
}

/**
 * Subtract `days` from a `YYYY-MM-DD` string, returning a `YYYY-MM-DD` string.
 * Pure JS — easier to reason about than the inline SQLite `date(d, '-N days')`
 * trick, and the result becomes a plain parameter we can bind without playing
 * concatenation-precedence games inside SQL.
 */
function subtractDays(isoDate: string, days: number): string {
  const t = new Date(`${isoDate}T00:00:00Z`).getTime();
  return new Date(t - days * 86_400_000).toISOString().slice(0, 10);
}

export function applyRetention(db: Db, opts: ApplyRetentionOptions = {}): RetentionResult {
  const t0 = process.hrtime.bigint();
  const asOfDate = opts.asOfDate ?? new Date().toISOString().slice(0, 10);
  const repoKeep = opts.repoSnapshotsKeepDailyDays ?? 90;
  const assetKeep = opts.assetSnapshotsKeepDailyDays ?? 30;
  const repoCutoff = subtractDays(asOfDate, repoKeep);
  const assetCutoff = subtractDays(asOfDate, assetKeep);

  const tx = db.raw.transaction(() => {
    // repo_snapshots — keep only the latest row per (repo_id, ISO-week)
    // OUTSIDE the keep-daily window. strftime('%Y-%W', d) is week-of-year
    // (Monday-first); fine for "collapse to weekly".
    const repoBefore =
      db.raw.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM repo_snapshots').get()?.n ?? 0;
    db.raw
      .prepare(`
        DELETE FROM repo_snapshots
        WHERE snapshot_date < @cutoff
          AND (repo_id, snapshot_date) NOT IN (
            SELECT repo_id, MAX(snapshot_date)
            FROM repo_snapshots
            WHERE snapshot_date < @cutoff
            GROUP BY repo_id, strftime('%Y-%W', snapshot_date)
          )
      `)
      .run({ cutoff: repoCutoff });
    const repoAfter =
      db.raw.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM repo_snapshots').get()?.n ?? 0;

    // release_asset_snapshots — same shape, different threshold + key.
    const assetBefore =
      db.raw.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM release_asset_snapshots').get()
        ?.n ?? 0;
    db.raw
      .prepare(`
        DELETE FROM release_asset_snapshots
        WHERE snapshot_date < @cutoff
          AND (release_id, asset_name, snapshot_date) NOT IN (
            SELECT release_id, asset_name, MAX(snapshot_date)
            FROM release_asset_snapshots
            WHERE snapshot_date < @cutoff
            GROUP BY release_id, asset_name, strftime('%Y-%W', snapshot_date)
          )
      `)
      .run({ cutoff: assetCutoff });
    const assetAfter =
      db.raw.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM release_asset_snapshots').get()
        ?.n ?? 0;

    return {
      repoSnapshotsDeleted: repoBefore - repoAfter,
      assetSnapshotsDeleted: assetBefore - assetAfter,
    };
  });

  const { repoSnapshotsDeleted, assetSnapshotsDeleted } = tx();
  return {
    repoSnapshotsDeleted,
    assetSnapshotsDeleted,
    durationSec: Number(process.hrtime.bigint() - t0) / 1e9,
  };
}
