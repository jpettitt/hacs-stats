-- 0006_is_fork.sql — track whether each repo is a fork on GitHub.
--
-- Used by:
--   - Phase 6 discovery worker to skip forks when populating
--     discovery_queue (forks are usually low-signal duplicates and
--     inflate the catalogue with noise).
--   - The repo detail UI to surface a "fork" badge — existing
--     HACS-default forks aren't removed (HACS sometimes lists them
--     intentionally) but the label makes them obvious.
--
-- Backfill happens on the next scrape via updateRepoMetadata.

ALTER TABLE repos ADD COLUMN is_fork INTEGER NOT NULL DEFAULT 0;
