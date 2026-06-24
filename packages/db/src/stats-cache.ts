import type { StatsCacheRow } from '@hacs-stats/shared';
import type { Db } from './client.js';

/**
 * The rollup query in `apps/scraper/src/rollup.ts` does an INSERT OR REPLACE
 * across all repos in one shot — these helpers are for tests and the web
 * app, not the rollup itself.
 */

export function getStatsCacheRow(db: Db, repoId: number): StatsCacheRow | undefined {
  return db.raw
    .prepare<[number], StatsCacheRow>('SELECT * FROM stats_cache WHERE repo_id = ?')
    .get(repoId);
}

export function countStatsCacheRows(db: Db): number {
  const row = db.raw.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM stats_cache').get();
  return row?.n ?? 0;
}

/**
 * Manual upsert helper — tests use this to seed rows without running the full
 * rollup query. The orchestrator uses the rollup query directly.
 */
export function upsertStatsCacheRow(db: Db, row: StatsCacheRow): void {
  db.raw
    .prepare(`
      INSERT INTO stats_cache (
        repo_id, top_version_30d, top_version_downloads_30d,
        total_downloads_30d, star_delta_7d, star_delta_30d,
        latest_release_tag, latest_release_downloads,
        latest_release_downloads_30d,
        hot_release_tag_90d, hot_release_downloads_90d,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id) DO UPDATE SET
        top_version_30d              = excluded.top_version_30d,
        top_version_downloads_30d    = excluded.top_version_downloads_30d,
        total_downloads_30d          = excluded.total_downloads_30d,
        star_delta_7d                = excluded.star_delta_7d,
        star_delta_30d               = excluded.star_delta_30d,
        latest_release_tag           = excluded.latest_release_tag,
        latest_release_downloads     = excluded.latest_release_downloads,
        latest_release_downloads_30d = excluded.latest_release_downloads_30d,
        hot_release_tag_90d          = excluded.hot_release_tag_90d,
        hot_release_downloads_90d    = excluded.hot_release_downloads_90d,
        updated_at                   = excluded.updated_at
    `)
    .run(
      row.repo_id,
      row.top_version_30d,
      row.top_version_downloads_30d,
      row.total_downloads_30d,
      row.star_delta_7d,
      row.star_delta_30d,
      row.latest_release_tag,
      row.latest_release_downloads,
      row.latest_release_downloads_30d,
      row.hot_release_tag_90d,
      row.hot_release_downloads_90d,
      row.updated_at,
    );
}
