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

- [ ] Nightly step: compute `stats_cache` (top 30d release, deltas, totals)
- [ ] Nightly step: collapse old snapshots (>90d) to weekly
- [ ] Nightly step: collapse old asset snapshots (>30d) to weekly
- [ ] Tests with seeded historical data

*Acceptance:* `stats_cache` populated; old snapshot rows reduced as expected.

## Phase 5 — Frontend v1

Full dashboard, per the design.

- [ ] Landing page: trending, top by category, recently updated, new arrivals
- [ ] Repo detail page: charts (stars over time, downloads over time per release)
- [ ] Search box (SQLite FTS5)
- [ ] Category browse pages
- [ ] About / methodology page explaining the proxies and caveats
- [ ] RSS feed for new repos
- [ ] Author page (all repos by a given owner)

*Acceptance:* Public-readable site, fast, looks good.

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
