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
          -- Asset attribution: downloads are a proxy for INSTALLS, and each
          -- install corresponds to one download of one canonical asset. So
          -- we never SUM — we take the MAX download count, filtered to the
          -- declared hacs_filename when set. Without a declared filename,
          -- MAX across every asset on the release is the best guess at
          -- "the dominant asset that ~all installers fetch."
          SELECT
            rel.id      AS release_id,
            rel.repo_id AS repo_id,
            rel.tag     AS tag,
            COALESCE(MAX(
              CASE
                WHEN r.hacs_filename IS NULL OR w.asset_name = r.hacs_filename
                  THEN COALESCE(w.latest - w.earliest, 0)
              END
            ), 0) AS delta_30d
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
          -- 7d / 30d star deltas computed from repo_star_history (per-day
          -- buckets, fed by the scraper's step 2.5 from /stargazers
          -- timestamps). Replaces the old "diff today's repo_snapshot
          -- against the snapshot N days ago" approach, which gave delta=0
          -- for any repo we hadn't been snapshotting for N+ days. Star-
          -- history goes back to repo creation, so deltas are accurate
          -- on the first day a repo is in the catalogue.
          SELECT
            repo_id,
            COALESCE(SUM(CASE
              WHEN day BETWEEN date(@asOfDate, '-7 days') AND @asOfDate
              THEN stars_added END), 0) AS week_delta,
            COALESCE(SUM(CASE
              WHEN day BETWEEN date(@asOfDate, '-30 days') AND @asOfDate
              THEN stars_added END), 0) AS month_delta
          FROM repo_star_history
          GROUP BY repo_id
        ),
        ranked_stable_releases AS (
          -- The latest non-prerelease per repo, by publish date. Ties (multiple
          -- releases at the exact same timestamp) broken by tag DESC so the
          -- pick is stable across rollups.
          SELECT
            rel.repo_id,
            rel.id AS release_id,
            rel.tag,
            ROW_NUMBER() OVER (
              PARTITION BY rel.repo_id
              ORDER BY rel.published_at DESC, rel.tag DESC
            ) AS rn
          FROM releases rel
          WHERE rel.is_prerelease = 0
        ),
        latest_release_dl AS (
          -- Same attribution rule as release_delta: MAX over eligible
          -- assets (only the matching one when hacs_filename is set, or
          -- all of them otherwise). Never SUM — downloads proxy installs,
          -- and an install pulls one canonical asset.
          SELECT
            lsr.repo_id,
            lsr.tag,
            COALESCE(MAX(
              CASE
                WHEN r.hacs_filename IS NULL OR ras.asset_name = r.hacs_filename
                  THEN ras.download_count
              END
            ), 0) AS downloads
          FROM ranked_stable_releases lsr
          JOIN repos r ON r.id = lsr.repo_id
          LEFT JOIN release_asset_snapshots ras
            ON ras.release_id = lsr.release_id
            AND ras.snapshot_date = (
              SELECT MAX(snapshot_date) FROM release_asset_snapshots
            )
          WHERE lsr.rn = 1
          GROUP BY lsr.repo_id, lsr.tag
        ),
        latest_release_dl_30d AS (
          -- Clean 30d delta: change in latest_release_downloads over the
          -- last 30 days. Same attribution rule as latest_release_dl. The
          -- subquery picks the dominant asset's count from the EARLIEST
          -- snapshot in the window (MIN(count) within a monotonic counter
          -- = the value at the earliest observation); today's count is
          -- already computed in latest_release_dl above.
          --
          -- Subtracts ONE release's earliest from ONE release's latest →
          -- no double-counting from upgrades across releases (the bug the
          -- old total_downloads_30d had).
          SELECT
            lsr.repo_id,
            COALESCE(MAX(
              CASE
                WHEN r.hacs_filename IS NULL OR ras.asset_name = r.hacs_filename
                  THEN ras.download_count
              END
            ), 0) AS earliest_in_window
          FROM ranked_stable_releases lsr
          JOIN repos r ON r.id = lsr.repo_id
          LEFT JOIN release_asset_snapshots ras
            ON ras.release_id = lsr.release_id
            AND ras.snapshot_date = (
              SELECT MIN(snapshot_date)
              FROM release_asset_snapshots ras2
              WHERE ras2.release_id = lsr.release_id
                AND ras2.snapshot_date BETWEEN date(@asOfDate, '-30 days') AND @asOfDate
            )
          WHERE lsr.rn = 1
          GROUP BY lsr.repo_id
        ),
        window_assets_90d AS (
          -- Same shape as window_assets but a 90-day window — feeds the
          -- "hottest release in the last 90 days" picker.
          SELECT
            ras.release_id,
            ras.asset_name,
            MAX(CASE WHEN ras.snapshot_date = @asOfDate THEN ras.download_count END) AS latest,
            MIN(ras.download_count) AS earliest
          FROM release_asset_snapshots ras
          WHERE ras.snapshot_date BETWEEN date(@asOfDate, '-90 days') AND @asOfDate
          GROUP BY ras.release_id, ras.asset_name
        ),
        release_delta_90d AS (
          -- Per release, dominant-asset 90-day delta (MAX, not SUM).
          SELECT
            rel.id      AS release_id,
            rel.repo_id AS repo_id,
            rel.tag     AS tag,
            COALESCE(MAX(
              CASE
                WHEN r.hacs_filename IS NULL OR w.asset_name = r.hacs_filename
                  THEN COALESCE(w.latest - w.earliest, 0)
              END
            ), 0) AS delta_90d
          FROM releases rel
          JOIN repos r            ON r.id = rel.repo_id
          JOIN window_assets_90d w ON w.release_id = rel.id
          GROUP BY rel.id
        ),
        hot_90d AS (
          -- Per repo, the single release with the highest 90d delta.
          -- ROW_NUMBER picks rn=1; tie-broken by tag DESC for stability.
          SELECT
            repo_id, tag, delta_90d,
            ROW_NUMBER() OVER (
              PARTITION BY repo_id
              ORDER BY delta_90d DESC, tag DESC
            ) AS rn
          FROM release_delta_90d
        )
        INSERT INTO stats_cache (
          repo_id,
          top_version_30d,
          top_version_downloads_30d,
          total_downloads_30d,
          star_delta_7d,
          star_delta_30d,
          latest_release_tag,
          latest_release_downloads,
          latest_release_downloads_30d,
          hot_release_tag_90d,
          hot_release_downloads_90d,
          updated_at
        )
        SELECT
          r.id,
          rr.tag,
          rr.delta_30d,
          COALESCE(prd.total_downloads_30d, 0),
          COALESCE(sd.week_delta, 0),
          COALESCE(sd.month_delta, 0),
          lrd.tag,
          lrd.downloads,
          -- Clean install signal: today's latest-release downloads minus the
          -- same release's earliest-in-window downloads. COALESCE the baseline
          -- to 0 so brand-new releases (no snapshot in the window) report
          -- their full count as new in the window.
          COALESCE(lrd.downloads, 0) - COALESCE(lrd30.earliest_in_window, 0),
          h90.tag,
          h90.delta_90d,
          @nowIso
        FROM repos r
        LEFT JOIN ranked_releases rr
          ON rr.repo_id = r.id AND rr.rn = 1
        LEFT JOIN per_repo_dl prd
          ON prd.repo_id = r.id
        LEFT JOIN star_deltas sd
          ON sd.repo_id = r.id
        LEFT JOIN latest_release_dl lrd
          ON lrd.repo_id = r.id
        LEFT JOIN latest_release_dl_30d lrd30
          ON lrd30.repo_id = r.id
        LEFT JOIN hot_90d h90
          ON h90.repo_id = r.id AND h90.rn = 1
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
