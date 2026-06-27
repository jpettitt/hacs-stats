# hacs-stats — architecture

## Goals

- Public dashboard of HACS plugin / integration / theme usage and trends.
- Honest stats: never overcount, always label proxies as proxies.
- Cheap and simple to run on a single VPS (≤ 1 GB RAM footprint).
- Self-healing scraper that tolerates rate limits and transient GitHub errors.

## Non-goals (v1)

- Tracking actual Home Assistant installations (no telemetry exists).
- Realtime stats. Daily refresh is the resolution; nothing in HACS moves
  faster than that.
- Authenticated user accounts. Read-only public site.
- Comments, ratings, reviews. Out of scope — this is a data site.
- Horizontal scaling. One VPS, one SQLite file. If we ever need more, we'll
  port the db layer to Postgres — see "Future scaling" below.

## Data sources

| Source                                    | Use                                        | Frequency  |
| ----------------------------------------- | ------------------------------------------ | ---------- |
| `github.com/hacs/default` repo            | Canonical list of HACS-indexed repos       | Daily      |
| GitHub GraphQL API                        | Batched repo metadata (stars, forks, etc.) | Daily      |
| GitHub REST `/releases`                   | Releases + per-asset download counts       | Daily      |
| GitHub code search (`hacs.json` filename) | Discovery of unlisted custom repositories  | Weekly     |
| Per-repo `hacs.json`                      | Which asset HACS pulls for that repo       | On change  |
| User submissions form                     | Long-tail custom repos                     | Continuous |

## The download-count problem

GitHub release download counts are **cumulative per asset, since the asset was
uploaded**. There is no native way to ask "how many downloads happened in the
last 30 days." Compounding this:

1. A release often has 5-10 assets. Summing them inflates the count — HACS
   only downloads one specific file per release.
2. The asset HACS pulls is declared in the repo's `hacs.json` `filename` field.
   For plugins (Lovelace cards) the convention is `<name>.js`; for integrations
   it's commonly the repo's `.zip` archive.

**Our approach:**

- Cache each repo's `hacs.json` and record the canonical `hacs_filename`.
- For each release, snapshot the download count of **only that asset** daily.
- 30-day delta = `today's snapshot − snapshot from 30 days ago`, summed across
  all releases.
- "Top version in the last 30 days" = the single release with the highest
  30-day delta on its HACS asset.

## System diagram

```text
                ┌──────────────────────────────────────────────┐
                │  Cloudflare (CDN + TLS + DDoS)               │
                │   ─ proxied DNS for hacs-stats.dev / .com    │
                │   ─ edge cert publicly trusted (auto)        │
                │   ─ SSL/TLS mode: Full (not strict)          │
                │   ─ edge cache for static + select API paths │
                └────────────────┬─────────────────────────────┘
                                 │  HTTPS (Caddy self-signed,
                                 │   accepted by CF "Full")
                                 ▼
                ┌──────────────────────────────────────────────┐
                │  VPS (Ubuntu/Debian)                         │
                │                                              │
                │   Caddy :443  ──reverse proxy──▶ web :3000   │
                │                                  (Node, Hono)│
                │                                       │      │
                │                                       ▼      │
                │                                  SQLite file │
                │                                       ▲      │
                │                                       │      │
                │   systemd timer (daily 04:00 UTC)            │
                │     └─▶ scrape (Node script, one-shot)       │
                │           ─ fetch HACS default lists         │
                │           ─ GraphQL batch repo metadata      │
                │           ─ REST releases + asset downloads  │
                │           ─ write snapshots                  │
                │           ─ run stats rollup                 │
                │                                              │
                │   systemd timer (weekly Mon 03:00 UTC)       │
                │     └─▶ discover (Node script, one-shot)     │
                │           ─ code-search `hacs.json`          │
                │           ─ populate discovery_queue         │
                └──────────────────────────────────────────────┘
```

Two processes, both written in TypeScript, both run as the dedicated
`hacs-stats` system user:

- **`hacs-stats-web.service`** — long-running Hono server bound to
  `localhost:3000`. Caddy fronts it.
- **`hacs-stats-scrape.timer`** + **`hacs-stats-scrape.service`** — one-shot
  scrape job. systemd handles retries, logging to journald, and missed-run
  recovery.

No queue. No CPU limit. The scraper just iterates repos in-process with a
small concurrency limiter (8-16 in-flight GitHub requests at a time).

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

### SQLite pragmas

Set on connection open:

```sql
PRAGMA journal_mode = WAL;       -- concurrent reads while scraper writes
PRAGMA synchronous  = NORMAL;    -- WAL-safe; ~10x faster than FULL
PRAGMA foreign_keys = ON;        -- enforce REFERENCES
PRAGMA busy_timeout = 5000;      -- 5s wait before SQLITE_BUSY
PRAGMA temp_store   = MEMORY;
PRAGMA mmap_size    = 268435456; -- 256MB memory-mapped reads
```

The web process opens the DB read-only; the scraper opens read-write. WAL
mode lets the web process keep serving snapshots-of-the-moment while the
scraper is writing.

### Retention policy

- `repo_snapshots`: daily for 90 days, then **collapse to weekly** (keep one
  row per ISO week, drop the rest). Job runs nightly after the scrape.
- `release_asset_snapshots`: daily for 30 days, then weekly. Same job.
- `stats_cache`: rebuilt fresh nightly; no history needed.

Without rollups, asset snapshots grow ~30k releases × 365 = 11M rows/year.
SQLite handles that fine but disk + query time grow. Rollups keep us
comfortably under 1M rows.

## Update cadence

- **Daily** at 04:00 UTC for the default lists (~3k repos).
- **Weekly** Mon 03:00 UTC for the `hacs.json` code-search discovery job.
- **On-demand** via `sudo systemctl start hacs-stats-scrape.service` for
  manual refresh during development or after a deploy.

### Rate-limit budget

GitHub authenticated REST = 5000 req/hr; GraphQL = 5000 points/hr (much
better batching). For 3k repos:

- GraphQL metadata: 30-60 requests (50-100 repos per query) — trivial.
- REST releases: ~3k requests. One hour with auth. Comfortable.
- Per-repo `hacs.json`: only fetched on first sight or when the repo's HEAD
  SHA changes — almost free in steady state.

A daily scrape fits comfortably in a single hour. A GitHub **App** (15k/hr)
is overkill at v1; revisit if we ever need it.

## Filter & rejection matrix

Repos enter the catalogue through three channels (`source` column on
`repos`, also reflected in `discovery_queue.source`). The acceptance and
visibility rules differ per channel — keeping this table current avoids
having to grep `discover.ts`, `sweep-queue.ts`, `submit-validation.ts`,
and `leaders.ts` to reconstruct the policy:

| Rule | `default` (HACS list) | `code_search` (discovery) | `user_submission` |
| --- | --- | --- | --- |
| Stale-3y listing filter (`leaders.ts` ACTIVE_ONLY) | Hides | Hides | Hides |
| Discovery-time stale reject (1y) | n/a | Rejects (`discovery.ts` STALE_MS) | n/a |
| Submit-time stale reject (3y) | n/a | n/a | Rejects (`submit-validation.ts`) |
| Discovery-time 0-star reject | n/a | Rejects | n/a |
| Sweep stale-reject (1y, `sweep-queue.ts`) | n/a | Applies | **Spared** (submitter vouched) |
| Sweep 0-star reject | n/a | Applies | **Spared** |
| Suppressed flag (`hacs/integration` etc) | Hides | Hides | Rejects at submit |
| Re-discoverable after auto-reject | n/a | Yes (notes-marker excluded from skip-set) | Yes |
| Re-discoverable after manual reject | n/a | **No** (manual decisions are sticky) | **No** |

Asymmetry rationale:

- **Unattended channels are stricter.** `code_search` runs without human
  judgement — applying the tighter 1y / 0-star bars prevents queue
  flooding with low-signal candidates. Discovery's threshold lives in
  `apps/scraper/src/discovery.ts` (`STALE_MS`, 0-star check).
- **Submitters vouch with their attention.** A human filling out the
  /submit form is signal — we relax the auto-rejects accordingly and
  rely on the listing-time 3y filter as the final guard.
- **Manual rejections are sticky.** When an admin clicks Reject the
  decision is final; only automatic rejections (notes containing
  `auto-rejected` or `sweep:`) come back through re-discovery if the
  upstream condition flips. See the project memory note
  `queue-decisions-stringly-typed` — when a fourth decision source
  arrives, replace the notes-marker convention with a structured column.

Before adding a fourth channel or a new filter rule, update this table
in the same commit.

## Cloudflare-as-CDN setup

1. **DNS:** `hacs-stats.dev` A record → VPS public IP. Proxy status: **on**
   (orange cloud). `hacs-stats.com` → page rule redirect to `.dev`.
2. **SSL/TLS mode: Full** (NOT "Full (strict)"). Caddy serves a self-signed
   cert at the origin via the `tls internal` directive; CF "Full" accepts it
   without trying to verify against a public CA. No Origin Certificate to
   generate, no Let's Encrypt, no key material on the VPS we have to rotate.
   The publicly-trusted cert lives at the CF edge and is auto-managed.
3. **Caching:** default page rules for static assets (`/static/*`,
   `/favicon.ico`, etc.). API responses cached selectively via response
   headers from the Node app (`Cache-Control: public, max-age=300` for the
   leaderboard, `s-maxage` for the per-repo pages).
4. **Bot fighting:** keep at default. Rate-limit rule for `/api/*` at 60
   req/min/IP to make scraping painful but not block humans.

Trade-off worth knowing: "Full" doesn't verify the origin cert, so CF can't
detect a hypothetical MITM between CF and the VPS. Acceptable for a
read-only public stats site; if we ever serve anything sensitive we revisit.

See [deploy/README.md](./deploy/README.md) for click-by-click setup.

## Local development

Both apps run on plain Node. The DB is a single SQLite file at `./data/dev.db`.

```sh
pnpm migrate       # apply ./packages/db/migrations/*.sql to ./data/dev.db
pnpm dev:web       # nodemon/tsx watching apps/web/src/index.ts on :3000
pnpm dev:scraper   # one-shot: runs the full scrape and exits
pnpm seed          # one-shot: populates default lists (Phase 2+)
```

The `./data/` directory is gitignored but never auto-deleted, so snapshots
accumulate across restarts. To wipe: `rm -rf ./data/`.

No Cloudflare account, no `wrangler`, no remote DB needed for local dev. The
only external dependency is GitHub (a PAT in `.env`).

## Future scaling

The single-VPS shape works comfortably to ~50k tracked repos with daily
snapshots. If we ever blow past that:

- **DB:** swap `packages/db` from `better-sqlite3` to `postgres`. Schema is
  vanilla SQL; the only meaningful changes are `INTEGER PRIMARY KEY` →
  `BIGSERIAL` and a couple of column types. App code is insulated by the
  query helpers.
- **Web:** add a second Node process behind Caddy with a load-balanced
  upstream. Or stay single-process and add a read-replica.
- **Scraper:** parallelise across multiple machines by sharding on
  `repo_id % N`.

None of this is needed at v1.

## Resolved design decisions

| Decision          | Choice                                                      |
| ----------------- | ----------------------------------------------------------- |
| Domain            | **hacs-stats.dev** (primary), `hacs-stats.com` redirects    |
| Relationship      | Independent / unofficial. No HACS or HA endorsement claim.  |
| Hosting           | Single VPS (Ubuntu/Debian), Cloudflare in front for TLS/CDN |
| Database          | SQLite via `better-sqlite3` (single-file, WAL mode)         |
| Backend language  | TypeScript on Node 22+                                      |
| HTTP framework    | Hono with `@hono/node-server`                               |
| Scheduler         | `systemd` timer (no embedded cron)                          |
| Reverse proxy     | Caddy with `tls internal` (self-signed), CF "Full" upstream |
| Lint/format       | Biome (single binary)                                       |
| Tests             | Vitest                                                      |
| Frontend scope v1 | Full dashboard (leaderboard, search, categories, charts)    |
| Auth on the site  | None. Public read-only.                                     |
| Local-dev DB      | `./data/dev.db` (gitignored, persistent)                    |

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
4. **Backups.** SQLite is one file — easy to back up via `sqlite3 .backup`.
   Where to store the backups (off-host) is TBD. Probably rsync to another
   box on a daily systemd timer.
