# hacs-stats — TODO

Phased build plan. Each phase ends in something runnable.

## Phase 0 — Design & setup

- [x] Initial design discussion
- [x] Write [README.md](./README.md), [ARCHITECTURE.md](./ARCHITECTURE.md), this file
- [x] Decide on domain — **hacs-stats.dev** (primary), `.com` redirects
- [x] Decide on relationship — independent / unofficial
- [x] Decide on license — **closed source, Copyright John Pettitt** (no LICENSE file)
- [x] Decide on hosting — VPS + Cloudflare-as-CDN (replaces the earlier
      Cloudflare-Workers plan; CF kept only for edge TLS / CDN / DDoS)
- [x] `git init`, first commit
- [ ] Point `hacs-stats.dev` at Cloudflare (proxied A record → VPS IP), set SSL mode to "Full"

## Phase 1 — Scaffold (VPS edition)

Single-host Node monorepo: web server + scrape job + shared DB layer.

- [x] `pnpm` workspace at the root
- [x] `packages/shared` — HACS types, snapshot row types
- [x] `packages/db` — `better-sqlite3` client, pragmas, migration runner, typed query helpers
- [x] `apps/web` — Hono on `@hono/node-server`, binds `localhost:3000`, reads from SQLite (read-only)
- [x] `apps/scraper` — one-shot Node script, exits 0/1; self-applies migrations on start
- [x] `scripts/migrate.ts` — applies `packages/db/migrations/*.sql` in order
- [x] `scripts/seed.ts` — stub; Phase 2 fills in the real GitHub fetch
- [x] `.env.example` checked in; real `.env` gitignored. Default DB path resolved relative to repo root so all entrypoints share one file
- [x] `.gitignore` covers `./data/`, `.env`, `node_modules/`, `dist/`
- [x] Biome for lint/format
- [x] CI: lint + typecheck + test on push (GitHub Actions)
- [x] `deploy/` — `Caddyfile`, `hacs-stats-web.service`, `hacs-stats-scrape.{service,timer}`, `install.sh`, README with click-by-click VPS + CF Origin Cert setup

*Acceptance:* ✅ `pnpm migrate && pnpm dev:web` on a fresh checkout serves
`/health` and `/api/stats/overview`; rows written via `sqlite3` CLI or the
scraper are visible from the web app immediately; the row survives killing
and restarting the web process. Verified end-to-end.

## Phase 2 — Ingest HACS default lists

- [x] Fetch `hacs/default/{integration,plugin,theme,appdaemon,netdaemon,python_script,template}` via `/HEAD/` (branch-agnostic)
- [x] Upsert into `repos` with `source='default'`; re-runs are idempotent
- [x] Fetch each repo's `hacs.json` with concurrency limit, extract `filename` → `hacs_filename`
- [x] Tests with fixture JSON (22 tests total: concurrency limiter, list parser, manifest parser, db upsert)
- [x] Use `process.hrtime.bigint()` + transactioned batch upsert (3316 inserts in ~50ms)

*Acceptance:* ✅ One scrape run populates 3,316 repos across 7 categories in
~60s (3.3k `hacs.json` fetches, concurrency 12, 0 failures). 1,064 repos
publish a `filename`; the rest fall back to HACS naming convention (handled
in Phase 3 against release assets). Verified the web app reflects the count
after restart.

## Phase 3 — Daily snapshot scraper

- [x] GraphQL batch query for repo metadata (100 repos/batch, 7 fields each)
- [x] REST per-repo releases fetch, `Link: rel="next"` pagination, `maxPages` safety
- [x] ETag caching per repo (`If-None-Match` → 304 short-circuit; new migration 0002)
- [x] Write `repo_snapshots`, `releases`, `release_asset_snapshots`
- [x] In-process concurrency limiter (default 12, env-configurable)
- [x] Rate-limit guardian: pauses until window reset when remaining < threshold,
      observes both REST headers and GraphQL `rateLimit { remaining resetAt }`
- [x] Tests: GraphQL mapping + NOT_FOUND tolerance, REST pagination + 304/404,
      ETag-only-on-page-1, Link parser, rate-limit guard sleep/cushion (49 total)
- [x] `SCRAPE_LIMIT` + `SKIP_DEFAULTS` env vars for fast dev iteration
- [x] hacs.json fetch optimized to only hit new repos (saves ~3k requests/day)

*Acceptance:* ✅ Smoke test on 20 repos: 20 GraphQL snapshots, 553 releases,
47 asset snapshots, 0 failures, 3.9s. Re-run shows ETag short-circuit:
notModified=20, releasesWritten=0. Rate-limit budget at 4978/5000 after both
runs. Two daily runs will produce delta-able snapshots once we let it run
overnight.

## Phase 4 — Stats rollup + retention

- [x] Step 4 of orchestrator: `computeStatsCache` runs every scrape (~75ms
      for 3.3k repos), writes `top_version_30d`, `top_version_downloads_30d`,
      `total_downloads_30d`, `star_delta_7d`, `star_delta_30d`
- [x] Asset attribution honours `hacs_filename` when set; falls back to
      summing all assets per release when not (with a comment explaining why
      in `rollup.ts`)
- [x] `applyRetention` collapses `repo_snapshots` older than 90 days and
      `release_asset_snapshots` older than 30 days to one row per ISO week
      (latest-in-week wins); JS-computed cutoffs, not inline SQL date math
- [x] 14 new tests with seeded historical data — day-1 zero-delta case,
      `hacs_filename` filter, top-version tie-break, retention boundary
- [x] Web `/` and `/api/stats/overview` now serve top-by-stars and
      top-by-30d-downloads leaderboards rendered from `stats_cache`
- [x] Bugfix: `SCRAPE_LIMIT=0` was being treated as "no limit" because of
      truthy-string then falsy-number; now distinguishes undefined from 0

*Acceptance:* ✅ Full scrape now writes `stats_cache` (3,321 rows, ~75ms).
Verified rollup math by injecting a synthetic 30-day-ago baseline for
piitaya/lovelace-mushroom — got `top_version_30d=v5.2.0`,
`top_version_downloads_30d=5000`, `star_delta_30d=131`. Retention "nothing
old enough to collapse yet" — correct on day 1; the boundary tests prove
the math.

## Phase 5 — Frontend v1

Full dashboard, per the design.

- [x] Shared layout module with nav (Home / Categories / About) and search box
- [x] Landing page sections: top-by-stars, top-by-30d-downloads, trending
      (7d star delta), recently active (last commit), new arrivals
- [x] Repo detail page `/r/:owner/:name` with stat tiles, stars-over-time
      SVG chart, metadata table, recent releases with downloads
- [x] Search at `/search?q=` (LIKE, 100-char cap, 2-char minimum; LIKE
      metacharacters escaped against user input)
- [x] Categories index `/categories` + per-kind list `/category/:kind`
- [x] About / methodology page explaining the download-count caveats
- [x] JSON API: `/api/stats/overview`, `/api/repo/:owner/:name`
- [x] Pure server-rendered SVG charts — no client JS, CSP stays strict
- [x] `SNAPSHOT_DATE` env override on the scraper for dev-time history fakery
- [x] All page interpolations route through `escapeHtml` or `repoLink`;
      XSS regression in two new tables caught by existing test before push

Deferred to Phase 5.1 / 6:

- [ ] RSS feed for new repos
- [ ] Author page (all repos by a given owner) — `/o/:owner`
- [ ] Per-repo downloads chart (release-stacked area; needs more thinking)
- [ ] SQLite FTS5 search (LIKE is fine for 3k rows; promote at ~50k)
- [ ] Pagination on category / search pages

*Acceptance:* ✅ Public-readable site with 7 routes, all returning expected
status codes; 93 tests green including XSS smoke against three real
payloads; CSP/Referrer/Permissions/X-Content-Type-Options headers live;
home page renders 5 leaderboard sections in <100ms.

## Phase 6 — Discovery job

- [ ] Weekly systemd timer: GitHub code search for `hacs.json`
- [ ] Dedupe against `repos` and `discovery_queue`
- [ ] Admin endpoint to accept/reject queue items (basic auth)
- [ ] User submission form on the public site

*Acceptance:* Discovery queue fills weekly; admin can promote items to `repos`.

## Phase 7 — Polish & ops

- [ ] Per-repo "embed badge" (SVG download/star counts)
- [ ] "For authors" page with opt-out instructions
- [ ] Outreach to HACS team for endorsement / clarification of relationship
- [ ] Analytics (privacy-respecting — Plausible or self-hosted Umami)
- [ ] Public API docs
- [ ] Off-host SQLite backups (rsync to a second box on a systemd timer)
- [ ] Healthcheck endpoint + uptime monitoring

## Backlog / maybe-later

- HA forum scraping for additional discovery
- Per-repo dependency graph (integrations that depend on others)
- Issue / PR velocity stats
- Translation coverage (for integrations with `translations/`)
- "Healthy / stale / abandoned" classifier
- Cloudflare Tunnel instead of inbound 443 (close all VPS inbound ports)
- Port `packages/db` to Postgres (only if we ever outgrow SQLite)
