-- 0008_repo_lifecycle.sql — formal lifecycle state per repo.
--
-- States:
--   pending  — accepted into the catalogue but never successfully scraped.
--              Hidden from default listings; visible on /pending.
--              If the first TWO scrapes fail (e.g. validation passed at
--              submit-time but the repo was deleted before next scrape),
--              the row is deleted from the DB outright — the user can
--              resubmit if they want.
--   active   — most recent scrape succeeded. Default for HACS-default
--              repos that already worked. Shown everywhere.
--   offline  — was active, last scrape failed (404 / private / removed).
--              Hidden from leaderboards, badge on detail page.
--   removed  — has been offline ≥ 30 days. Hidden everywhere except
--              /removed.
--
-- first_failure_at:
--   Set when state first becomes 'offline' (or, for pending, on first
--   failure). Cleared on recovery. The 30-day "removed" threshold is
--   measured from this timestamp.
--
-- consecutive_failures:
--   Bumped each time a scrape fails. Reset to 0 on success. Used to
--   trigger pending→delete after 2 fails.
--
-- Backfill:
--   Anything previously scraped (last_scraped_at IS NOT NULL) → 'active'.
--   Everything else stays at the default 'pending' — which for HACS-default
--   repos that haven't yet been scraped is the right read.

ALTER TABLE repos ADD COLUMN state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE repos ADD COLUMN first_failure_at TEXT;
ALTER TABLE repos ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_repos_state ON repos(state);

UPDATE repos SET state = 'active' WHERE last_scraped_at IS NOT NULL;
