import type { Db } from '@hacs-stats/db';

/**
 * Rebuild `stats_cache` from scratch.
 *
 * Two independent computations joined per repo:
 *
 * 1. **Download deltas** — for every (release_id, asset_name) we compute
 *    `latest_download_count - earliest_download_count` over the last 30 days
 *    of asset snapshots. download_count is monotonic (assets only accumulate
 *    downloads), so `MIN(download_count)` within the window is the earliest
 *    value. The per-release delta sums across that release's assets, BUT —
 *    when the owning repo declared a `hacs_filename` in its hacs.json, only
 *    that one asset counts. This is the honesty trick from ARCHITECTURE.md:
 *    we don't want to inflate counts by summing every .zip + source tarball
 *    + signed build when HACS only ever downloads one file.
 *
 * 2. **Star deltas** — `today_stars - earliest_stars_in_window`. Same window
 *    structure, applied to `repo_snapshots`. 7d and 30d are computed
 *    independently so the windows can be partially present.
 *
 * `top_version_30d` is the release tag with the highest 30-day download delta
 * for that repo; ties tie-break by tag descending (a totally arbitrary but
 * stable choice — every version of this query needs to produce the same
 * cache row given the same input data).
 *
 * On day 1 (when latest_date == earliest_date), deltas are 0 by construction.
 * That's correct, not a bug — we haven't observed any change yet.
 */
export interface ComputeStatsCacheResult {
  rowsWritten: number;
  durationSec: number;
  /** Pinned at the start of the rollup so all the CTEs see the same "today". */
  asOfDate: string;
}

export interface ComputeStatsCacheOptions {
  /** Override "today" — tests use this to pin a date against seeded data. */
  asOfDate?: string;
  /** Override `Date.now()` for the `updated_at` column (tests). */
  nowIso?: string;
}

export function computeStatsCache(
  db: Db,
  opts: ComputeStatsCacheOptions = {},
): ComputeStatsCacheResult {
  const t0 = process.hrtime.bigint();
  const nowIso = opts.nowIso ?? new Date().toISOString();
  // Pin "today" once at the top so the asset-snapshot and repo-snapshot
  // sub-queries can't drift onto different reference dates.
  const asOfDate =
    opts.asOfDate ??
    db.raw
      .prepare<[], { d: string | null }>('SELECT MAX(snapshot_date) AS d FROM repo_snapshots')
      .get()?.d ??
    new Date().toISOString().slice(0, 10);

  // One big transactional rebuild — wipe + repopulate. stats_cache is a
  // derived table; we never want a stale row to linger.
  const tx = db.raw.transaction(() => {
    db.raw.exec('DELETE FROM stats_cache');

    db.raw
      .prepare(`
        WITH window_assets AS (
          -- Per (release, asset): latest and earliest download counts within
          -- the last 30 days. Monotonic counters → MIN(count) = earliest value.
          SELECT
            ras.release_id,
            ras.asset_name,
            MAX(CASE WHEN ras.snapshot_date = @asOfDate THEN ras.download_count END) AS latest,
            MIN(ras.download_count) AS earliest
          FROM release_asset_snapshots ras
          WHERE ras.snapshot_date BETWEEN date(@asOfDate, '-30 days') AND @asOfDate
          GROUP BY ras.release_id, ras.asset_name
        ),
        release_delta AS (
          SELECT
            rel.id           AS release_id,
            rel.repo_id      AS repo_id,
            rel.tag          AS tag,
            -- Asset attribution: if the repo declares a hacs_filename, ONLY
            -- that asset counts; otherwise sum every asset on the release.
            SUM(
              CASE
                WHEN r.hacs_filename IS NOT NULL AND w.asset_name != r.hacs_filename THEN 0
                ELSE COALESCE(w.latest - w.earliest, 0)
              END
            ) AS delta_30d
          FROM releases rel
          JOIN repos r        ON r.id = rel.repo_id
          JOIN window_assets w ON w.release_id = rel.id
          GROUP BY rel.id
        ),
        ranked_releases AS (
          SELECT
            repo_id, tag, delta_30d,
            ROW_NUMBER() OVER (
              PARTITION BY repo_id
              ORDER BY delta_30d DESC, tag DESC
            ) AS rn
          FROM release_delta
        ),
        per_repo_dl AS (
          SELECT repo_id, SUM(delta_30d) AS total_downloads_30d
          FROM release_delta
          GROUP BY repo_id
        ),
        star_deltas AS (
          -- Compare today's stars vs the earliest snapshot in each window.
          -- A repo with only today's snapshot lands with delta = 0.
          SELECT
            repo_id,
            MAX(CASE WHEN snapshot_date = @asOfDate THEN stars END) AS today,
            MIN(CASE
              WHEN snapshot_date BETWEEN date(@asOfDate, '-7 days') AND @asOfDate
              THEN stars END) AS week_ago,
            MIN(CASE
              WHEN snapshot_date BETWEEN date(@asOfDate, '-30 days') AND @asOfDate
              THEN stars END) AS month_ago
          FROM repo_snapshots
          GROUP BY repo_id
        )
        INSERT INTO stats_cache (
          repo_id,
          top_version_30d,
          top_version_downloads_30d,
          total_downloads_30d,
          star_delta_7d,
          star_delta_30d,
          updated_at
        )
        SELECT
          r.id,
          rr.tag,
          rr.delta_30d,
          COALESCE(prd.total_downloads_30d, 0),
          COALESCE(sd.today - sd.week_ago, 0),
          COALESCE(sd.today - sd.month_ago, 0),
          @nowIso
        FROM repos r
        LEFT JOIN ranked_releases rr
          ON rr.repo_id = r.id AND rr.rn = 1
        LEFT JOIN per_repo_dl prd
          ON prd.repo_id = r.id
        LEFT JOIN star_deltas sd
          ON sd.repo_id = r.id
      `)
      .run({ asOfDate, nowIso });
  });
  tx();

  const rowsWritten =
    db.raw.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM stats_cache').get()?.n ?? 0;

  return {
    rowsWritten,
    durationSec: Number(process.hrtime.bigint() - t0) / 1e9,
    asOfDate,
  };
}
