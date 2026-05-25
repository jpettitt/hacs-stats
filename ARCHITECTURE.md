# hacs-stats — architecture

## Goals

- Public dashboard of HACS plugin / integration / theme usage and trends.
- Honest stats: never overcount, always label proxies as proxies.
- Cheap to run (≤ $5/mo at expected scale).
- Self-healing scraper that tolerates rate limits, transient GitHub errors,
  and partial Cron-trigger CPU budgets.

## Non-goals (v1)

- Tracking actual Home Assistant installations (no telemetry exists).
- Realtime stats. Daily refresh is the resolution; nothing in HACS moves
  faster than that.
- Authenticated user accounts. Read-only public site.
- Comments, ratings, reviews. Out of scope — this is a data site, not a
  community.

## Data sources

| Source                                    | Use                                         | Frequency |
| ----------------------------------------- | ------------------------------------------- | --------- |
| `github.com/hacs/default` repo            | Canonical list of HACS-indexed repos        | Daily     |
| GitHub GraphQL API                        | Batched repo metadata (stars, forks, etc.) | Daily     |
| GitHub REST `/releases`                   | Releases + per-asset download counts        | Daily     |
| GitHub code search (`hacs.json` filename) | Discovery of unlisted custom repositories   | Weekly    |
| Per-repo `hacs.json`                      | Which asset HACS pulls for that repo        | On change |
| User submissions form                     | Long-tail custom repos                      | Continuous |

## The download-count problem

GitHub release download counts are **cumulative per asset, since the asset was
uploaded**. There is no native way to ask "how many downloads happened in the
last 30 days." Compounding this:

1. A release often has 5-10 assets (`.zip`, `.tar.gz`, source archives, signed
   builds, individual files). Summing them inflates the count — HACS only
   downloads one specific file per release.
2. The asset HACS pulls is declared in the repo's `hacs.json` `filename` field.
   For plugins (Lovelace cards), the convention is `<name>.js`. For
   integrations, it's commonly the repo's `.zip` archive.

**Our approach:**

- Cache each repo's `hacs.json` and record the canonical `hacs_filename`.
- For each release, snapshot the download count of **only that asset** daily.
- 30-day delta = `today's snapshot − snapshot from 30 days ago`, summed across
  all releases.
- "Top version in the last 30 days" = the single release with the highest
  30-day delta on its HACS asset.

This gives an honest picture of what HACS users are actively downloading right
now, tolerant of users who don't upgrade immediately.

## System diagram

```
                  ┌─────────────────────────────────────────┐
  Cron (daily) ─▶ │  scraper Worker                         │
                  │   1. fetch HACS default lists            │
                  │   2. enqueue repos into Queue            │
                  │   3. consumer: GraphQL batch metadata    │
                  │   4. consumer: REST releases + assets    │
                  │   5. write snapshots to D1               │
                  │   6. run stats rollup                    │
                  └────────────────────┬────────────────────┘
                                       │
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │  D1 (SQLite)                            │
                  │   repos, repo_snapshots, releases,      │
                  │   release_asset_snapshots, stats_cache, │
                  │   discovery_queue                       │
                  └────────────────────┬────────────────────┘
                                       │
                  ┌────────────────────▼────────────────────┐
  Users ─────────▶│  frontend Worker (Pages + Hono)         │
                  │   SSR dashboard, search, charts,        │
                  │   /api/* for client filtering            │
                  └─────────────────────────────────────────┘

  Cron (weekly) ─▶ discovery Worker
                     code-search `hacs.json` → discovery_queue
```

The scraper uses **Cloudflare Queues** between steps 2 and 3-4 to chunk work
across many short Worker invocations. This sidesteps the 30s (free) / 5min
(paid) CPU limit per invocation: each repo is one queue message, processed
independently.

## Database schema

```sql
CREATE TABLE repos (
  id              INTEGER PRIMARY KEY,
  owner           TEXT NOT NULL,
  name            TEXT NOT NULL,
  full_name       TEXT NOT NULL UNIQUE,        -- "owner/name"
  kind            TEXT NOT NULL,               -- integration|plugin|theme|appdaemon|python_script|template
  source          TEXT NOT NULL,               -- default|discovered|submitted
  hacs_filename   TEXT,                        -- from the repo's hacs.json
  description     TEXT,
  archived        INTEGER NOT NULL DEFAULT 0,
  default_branch  TEXT,
  first_seen_at   TEXT NOT NULL,               -- ISO8601 UTC
  last_scraped_at TEXT
);

CREATE TABLE repo_snapshots (
  repo_id         INTEGER NOT NULL REFERENCES repos(id),
  snapshot_date   TEXT NOT NULL,               -- YYYY-MM-DD
  stars           INTEGER NOT NULL,
  forks           INTEGER NOT NULL,
  open_issues     INTEGER NOT NULL,
  last_commit_at  TEXT,
  PRIMARY KEY (repo_id, snapshot_date)
);

CREATE TABLE releases (
  id              INTEGER PRIMARY KEY,
  repo_id         INTEGER NOT NULL REFERENCES repos(id),
  tag             TEXT NOT NULL,
  published_at    TEXT NOT NULL,
  is_prerelease   INTEGER NOT NULL DEFAULT 0,
  html_url        TEXT NOT NULL,
  UNIQUE (repo_id, tag)
);

CREATE TABLE release_asset_snapshots (
  release_id      INTEGER NOT NULL REFERENCES releases(id),
  asset_name      TEXT NOT NULL,
  snapshot_date   TEXT NOT NULL,
  download_count  INTEGER NOT NULL,
  PRIMARY KEY (release_id, asset_name, snapshot_date)
);

CREATE TABLE discovery_queue (
  url             TEXT PRIMARY KEY,
  source          TEXT NOT NULL,               -- code_search|user_submission|forum_scrape
  discovered_at   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|rejected|error
  notes           TEXT
);

CREATE TABLE stats_cache (
  repo_id                     INTEGER PRIMARY KEY REFERENCES repos(id),
  top_version_30d             TEXT,
  top_version_downloads_30d   INTEGER,
  total_downloads_30d         INTEGER,
  star_delta_7d               INTEGER,
  star_delta_30d              INTEGER,
  updated_at                  TEXT NOT NULL
);

CREATE INDEX idx_snapshots_date ON repo_snapshots(snapshot_date);
CREATE INDEX idx_asset_snapshots_date ON release_asset_snapshots(snapshot_date);
CREATE INDEX idx_repos_kind ON repos(kind);
```

### Retention policy

- `repo_snapshots`: daily for 90 days, then **collapse to weekly** (keep one
  row per ISO week, drop the rest). Job runs nightly.
- `release_asset_snapshots`: daily for 30 days, then weekly. Same job.
- `stats_cache`: rebuilt fresh nightly; no history needed.

Without rollups, asset snapshots grow ~30k releases × 365 = 11M rows/year,
which D1 can technically handle but slows queries. Rollups keep us comfortably
under 1M rows.

## Update cadence

- **Daily** for everything in the default lists (~3k repos).
- **Weekly** for the `hacs.json` code-search discovery worker.
- **On-demand** refresh endpoint (rate-limited) for repo authors who want to
  push the latest stats sooner.

### Rate-limit budget

GitHub authenticated REST = 5000 req/hr; GraphQL = 5000 points/hr (with much
better batching). For 3k repos:

- GraphQL metadata: 30-60 requests (50-100 repos per query) — trivial.
- REST releases: ~3k requests. One hour with auth. Comfortable.
- Per-repo `hacs.json`: only fetched on first sight or when the repo's HEAD
  SHA changes — almost free in steady state.

Plenty of headroom for a daily cadence. A GitHub **App** (15k/hr) is overkill
at v1; revisit if we hit limits.

## Cloudflare-specific concerns

| Concern                  | Mitigation                                         |
| ------------------------ | -------------------------------------------------- |
| Worker CPU limit (30s)   | Queue + one-repo-per-message scraper consumers     |
| D1 storage cap (10 GB)   | Snapshot rollups (daily → weekly after window)     |
| D1 write throughput      | Batch inserts in single transactions per consumer  |
| Cron-trigger reliability | Idempotent scrape: `snapshot_date` as PK component |
| Secret storage           | `wrangler secret put GITHUB_TOKEN`                 |

## Local development

The whole stack must run on a developer machine **and keep its data between
runs.** GitHub's API doesn't backfill download history, so re-bootstrapping
from scratch loses real signal — local data needs to persist just like prod.

### How that works

- `wrangler dev` runs both Workers locally. The Workers runtime is `workerd`,
  the same engine used in production.
- D1 has a **local mode** backed by a SQLite file in
  `.wrangler/state/v3/d1/<binding>/<db>.sqlite`. Wrangler creates this on
  first run and reuses it on every subsequent run.
- `.wrangler/` is **gitignored but never auto-deleted**. The SQLite file
  survives across `wrangler dev` restarts, machine restarts, and
  `pnpm install`. It only disappears if a developer explicitly removes it.
- Migrations apply identically to local and remote D1 via
  `wrangler d1 migrations apply <db> --local` / `--remote`.
- Queues have a local mode too (`wrangler dev` simulates them in-process), so
  the chunked scraper flow works end-to-end on a laptop.

### Dev-only scrape trigger

In prod the scraper fires from Cron. In dev, waiting for Cron is painful, so
the scraper Worker exposes a dev-only HTTP route:

```http
POST /admin/run-scrape       (only mounted when ENVIRONMENT === 'dev')
```

Hitting it from `curl` enqueues the same work the Cron trigger would. Same
code path, no separate dev-only logic.

### First-run seeding

A `pnpm seed` script does one full scrape against the real GitHub API
(authenticated with the dev's own PAT, stored in `.dev.vars`), populating the
local D1 with current data. From then on, the daily delta math works
naturally — each subsequent `pnpm seed` (or `/admin/run-scrape` hit) writes
another snapshot row keyed on today's date, and the dashboard becomes useful
immediately rather than after 30 days of local cron.

### Files

```text
.wrangler/         # local Wrangler state (D1 SQLite, KV, Queue) — gitignored
.dev.vars          # local secrets (GITHUB_TOKEN, etc.) — gitignored
wrangler.toml      # bindings, Cron triggers, env config — committed
```

## Resolved design decisions

| Decision           | Choice                                                     |
| ------------------ | ---------------------------------------------------------- |
| Domain             | **hacs-stats.dev** (primary), `hacs-stats.com` redirects   |
| Relationship       | Independent / unofficial. No HACS or HA endorsement claim. |
| Hosting            | Cloudflare Workers + D1 + Pages + Queues + Cron Triggers   |
| Backend language   | TypeScript                                                 |
| Frontend scope v1  | Full dashboard (leaderboard, search, categories, charts)   |
| Auth on the site   | None. Public read-only.                                    |
| Local-dev data     | Persisted via `.wrangler/state/` SQLite (never auto-wiped) |

## Remaining open questions

1. **Author opt-out.** Should plugin authors be able to request removal /
   anonymization? Probably yes — easy form, manual review. Decide before
   public launch.
2. **Forum scraping.** Worth the complexity? The HA community forum has a
   long-tail of custom repos that don't show up in code search. Defer to
   post-v1.
3. **Historical backfill.** GitHub does **not** retroactively give us download
   history. The dashboard's "30-day delta" stat reads zero until we've been
   scraping for 30 days. Plan: soft-launch the scraper ~30 days before any
   public announcement, and put a prominent "stats since YYYY-MM-DD" note on
   the site.
4. **License.** MIT vs. Apache 2.0 vs. AGPL. MIT is the path of least
   friction; AGPL would prevent a closed-source clone if that ever mattered.
   Default: MIT unless there's a reason otherwise.
