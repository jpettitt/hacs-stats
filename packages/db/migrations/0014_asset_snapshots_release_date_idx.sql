-- 0014: composite index for the per-release "downloads on latest snapshot
-- date" lookup. The PK (release_id, asset_name, snapshot_date) is
-- selective on release_id but then scans all asset_name × date rows
-- for that release to find ones matching today's date. The other index
-- (snapshot_date only) is selective on date but then scans the day's
-- thousands of asset snapshots looking for the right release. This
-- composite seeks both columns at once.
CREATE INDEX IF NOT EXISTS idx_asset_snapshots_release_date
  ON release_asset_snapshots(release_id, snapshot_date);
