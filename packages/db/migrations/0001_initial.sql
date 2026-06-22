-- 0001_initial.sql — schema for hacs-stats
-- Applied by scripts/migrate.ts. Each migration runs in a transaction.

CREATE TABLE IF NOT EXISTS repos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner           TEXT NOT NULL,
  name            TEXT NOT NULL,
  full_name       TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,
  source          TEXT NOT NULL,
  hacs_filename   TEXT,
  description     TEXT,
  archived        INTEGER NOT NULL DEFAULT 0,
  default_branch  TEXT,
  first_seen_at   TEXT NOT NULL,
  last_scraped_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_repos_kind ON repos(kind);
CREATE INDEX IF NOT EXISTS idx_repos_source ON repos(source);

CREATE TABLE IF NOT EXISTS repo_snapshots (
  repo_id         INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  snapshot_date   TEXT NOT NULL,
  stars           INTEGER NOT NULL,
  forks           INTEGER NOT NULL,
  open_issues     INTEGER NOT NULL,
  last_commit_at  TEXT,
  PRIMARY KEY (repo_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_date ON repo_snapshots(snapshot_date);

CREATE TABLE IF NOT EXISTS releases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  tag             TEXT NOT NULL,
  published_at    TEXT NOT NULL,
  is_prerelease   INTEGER NOT NULL DEFAULT 0,
  html_url        TEXT NOT NULL,
  UNIQUE (repo_id, tag)
);

CREATE TABLE IF NOT EXISTS release_asset_snapshots (
  release_id      INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  asset_name      TEXT NOT NULL,
  snapshot_date   TEXT NOT NULL,
  download_count  INTEGER NOT NULL,
  PRIMARY KEY (release_id, asset_name, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_asset_snapshots_date
  ON release_asset_snapshots(snapshot_date);

CREATE TABLE IF NOT EXISTS discovery_queue (
  url             TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  discovered_at   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS stats_cache (
  repo_id                     INTEGER PRIMARY KEY
                                REFERENCES repos(id) ON DELETE CASCADE,
  top_version_30d             TEXT,
  top_version_downloads_30d   INTEGER,
  total_downloads_30d         INTEGER,
  star_delta_7d               INTEGER,
  star_delta_30d              INTEGER,
  updated_at                  TEXT NOT NULL
);
