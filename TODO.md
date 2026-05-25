# hacs-stats — TODO

Phased build plan. Each phase ends in something runnable.

## Phase 0 — Design & setup

- [x] Initial design discussion
- [x] Write [README.md](./README.md), [ARCHITECTURE.md](./ARCHITECTURE.md), this file
- [x] Decide on domain — **hacs-stats.dev** (primary), `.com` redirects
- [x] Decide on relationship — independent / unofficial
- [ ] `git init`, first commit
- [ ] Decide on license (default MIT unless reason otherwise)
- [ ] Point `hacs-stats.dev` at Cloudflare (nameservers / NS records)

## Phase 1 — Scaffold

Cloudflare Wrangler monorepo with two Workers + shared package.

- [ ] `pnpm` workspace, root `wrangler.toml`
- [ ] `packages/db` — D1 schema, migrations, typed query helpers
- [ ] `packages/shared` — types shared between Workers
- [ ] `workers/scraper` — Cron-triggered, Queue-consumer, **dev-only `/admin/run-scrape`** HTTP route
- [ ] `workers/frontend` — Hono SSR + `/api/*`
- [ ] `.dev.vars.example` checked in; real `.dev.vars` gitignored
- [ ] `pnpm seed` script — one-shot real-GitHub scrape into local D1
- [ ] `.gitignore` covers `.wrangler/`, `.dev.vars`, `node_modules/`, `dist/`
- [ ] CI: typecheck + test on push (GitHub Actions)

*Acceptance:* `wrangler dev` boots both Workers; `wrangler d1 migrations apply
--local` works; `pnpm seed` populates a real-data local D1; data survives
stopping and restarting `wrangler dev`.

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
- [ ] Queue chunking — one repo per message, idempotent
- [ ] Rate-limit handling: respect `x-ratelimit-remaining`, pause queue
- [ ] Tests: mocked GitHub responses

*Acceptance:* After 2 daily runs, deltas computable for stars and downloads.

## Phase 4 — Stats rollup + retention

- [ ] Nightly job: compute `stats_cache` (top 30d release, deltas, totals)
- [ ] Nightly job: collapse old snapshots (>90d) to weekly
- [ ] Nightly job: collapse old asset snapshots (>30d) to weekly
- [ ] Tests with seeded historical data

*Acceptance:* `stats_cache` populated; old snapshot rows reduced as expected.

## Phase 5 — Frontend v1

Full dashboard, per the design.

- [ ] Landing page: trending, top by category, recently updated, new arrivals
- [ ] Repo detail page: charts (stars over time, downloads over time per release)
- [ ] Search box (FTS or simple LIKE — D1 has FTS5)
- [ ] Category browse pages
- [ ] About / methodology page explaining the proxies and caveats
- [ ] RSS feed for new repos
- [ ] Author page (all repos by a given owner)

*Acceptance:* Public-readable site, fast, looks good.

## Phase 6 — Discovery worker

- [ ] Weekly Cron: GitHub code search for `hacs.json`
- [ ] Dedupe against `repos` and `discovery_queue`
- [ ] Admin endpoint to accept/reject queue items (basic auth)
- [ ] User submission form on the public site

*Acceptance:* Discovery queue fills weekly; admin can promote items to `repos`.

## Phase 7 — Polish

- [ ] Per-repo "embed badge" (SVG download/star counts)
- [ ] "For authors" page with opt-out instructions
- [ ] Outreach to HACS team for endorsement / clarification of relationship
- [ ] Analytics (privacy-respecting — Plausible or self-hosted Umami)
- [ ] Public API docs

## Backlog / maybe-later

- HA forum scraping for additional discovery
- Per-repo dependency graph (integrations that depend on others)
- Issue / PR velocity stats
- Translation coverage (for integrations with `translations/`)
- "Healthy / stale / abandoned" classifier
