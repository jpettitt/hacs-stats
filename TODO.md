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

- [ ] Fetch `hacs/default/{integration,plugin,theme,appdaemon,python_script,template}`
- [ ] Upsert into `repos` with `source='default'`
- [ ] Fetch each repo's `hacs.json`, extract `filename` → `hacs_filename`
- [ ] Tests with fixture JSON

*Acceptance:* `repos` table populated with ~3k rows after one scrape run.

## Phase 3 — Daily snapshot scraper

- [ ] GraphQL batch query for repo metadata (stars/forks/issues/etc.)
- [ ] REST per-repo releases fetch (paginated, ETag-cached)
- [ ] Write `repo_snapshots`, `releases`, `release_asset_snapshots`
- [ ] In-process concurrency limiter (default 12)
- [ ] Rate-limit handling: respect `x-ratelimit-remaining`, sleep on exhaustion
- [ ] Tests: mocked GitHub responses

*Acceptance:* After 2 daily runs, deltas computable for stars and downloads.

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
