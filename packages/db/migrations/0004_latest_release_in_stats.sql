-- 0004_latest_release_in_stats.sql — stats_cache learns about each repo's
-- latest non-prerelease release and its cumulative download count.
--
-- Why: the 30-day delta is a velocity metric, but "downloads of the current
-- stable release" is the closer proxy for current install base, which is
-- what users actually want to see on a leaderboard. The old 30d columns
-- stay for now (still feeds the "trending" view), but the UI's headline
-- "downloads" number now comes from these.

ALTER TABLE stats_cache ADD COLUMN latest_release_tag TEXT;
ALTER TABLE stats_cache ADD COLUMN latest_release_downloads INTEGER;
