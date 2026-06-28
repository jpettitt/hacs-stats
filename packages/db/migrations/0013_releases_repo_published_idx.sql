-- 0013: speed up the "latest release per repo" lookup on every leader
-- query (added in 0012-era when we replaced last-commit with last-
-- release as the recent-activity signal). Without this index, SQLite
-- has to scan releases for every row of leader queries — on the prod
-- DB (40k+ release rows) that's the difference between sub-100ms
-- pages and 2-3 second renders.
CREATE INDEX IF NOT EXISTS idx_releases_repo_published
  ON releases(repo_id, published_at);
