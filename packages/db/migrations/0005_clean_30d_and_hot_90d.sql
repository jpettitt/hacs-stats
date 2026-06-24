-- 0005_clean_30d_and_hot_90d.sql — two new attribution-correct metrics on
-- stats_cache.
--
--   latest_release_downloads_30d
--     Change in `latest_release_downloads` over the last 30 days. The clean
--     "new installs onto the current stable release" signal. Replaces the
--     old total_downloads_30d (which SUM'd per-release deltas across every
--     release of the repo and double-counted upgrades). Old column kept for
--     backwards compatibility for one release; ignored by the UI.
--
--   hot_release_tag_90d  /  hot_release_downloads_90d
--     The release with the highest 90-day download delta on its dominant
--     asset — surfaces "users are pulling v2.1.0 hard right now" even
--     when v3.0.0 is the latest tagged stable. Useful for spotting the
--     version people actually run vs. the one the author published.

ALTER TABLE stats_cache ADD COLUMN latest_release_downloads_30d INTEGER;
ALTER TABLE stats_cache ADD COLUMN hot_release_tag_90d TEXT;
ALTER TABLE stats_cache ADD COLUMN hot_release_downloads_90d INTEGER;
