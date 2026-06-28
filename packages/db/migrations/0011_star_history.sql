-- 0011: per-day stars-added history. Built daily by the scraper from
-- GitHub's /stargazers endpoint (which returns timestamps for each
-- star event when called with Accept: application/vnd.github.v3.star+json).
--
-- Aggregated by UTC day, not per-star: the dashboard never displays
-- individual users and per-day resolution cuts row count by ~3 orders
-- of magnitude vs storing each star event. Cumulative chart at any
-- date = SUM(stars_added) WHERE day <= ?, cheap with the composite PK.
--
-- Negative stars_added is legal: when GitHub's stargazer count goes
-- DOWN (an unstar) we can't tell which historical day to debit, so we
-- record a negative delta on today. Cumulative line stays accurate;
-- daily-delta chart shows a one-day blip we accept as imprecise.
CREATE TABLE IF NOT EXISTS repo_star_history (
  repo_id      INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  day          TEXT    NOT NULL,        -- 'YYYY-MM-DD' UTC
  stars_added  INTEGER NOT NULL,
  PRIMARY KEY (repo_id, day)
);

CREATE INDEX IF NOT EXISTS idx_star_history_repo_day
  ON repo_star_history(repo_id, day);
