# hacs-stats

Usage statistics for [HACS](https://hacs.xyz/) — the Home Assistant Community
Store. Tracks downloads, stars, and trending plugins, integrations, themes, and
custom components across the HACS ecosystem.

Lives at **[hacs-stats.dev](https://hacs-stats.dev)** (with `hacs-stats.com`
redirecting there).

> **Unofficial.** This is an independent project. It is not run, endorsed, or
> reviewed by the HACS maintainers or the Home Assistant project. All data is
> sourced from public GitHub APIs.
>
> **Status:** v0 — design phase. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the
> design and [TODO.md](./TODO.md) for the phased build plan.

## What we track

For every HACS-discoverable repository:

- **Stars** and 7/30-day star deltas (interest signal)
- **GitHub release download counts**, scoped to the asset HACS actually pulls,
  with **daily snapshots** so we can compute true 30-day deltas (cumulative
  per-asset counters can't be filtered to a time window without snapshots)
- **Top release in the last 30 days** by downloads — captures what users are
  *actually running right now*, tolerant of slow upgraders
- **Forks**, **open issues**, **last commit**, **last release** — health signals
- **Category** (integration / plugin / theme / appdaemon / python_script / template)

Downloads are a **proxy for installs**, not installs themselves. Home Assistant
does not phone home, so true install counts are unknowable.

## Discovery

Two sources:

1. **HACS default lists** — `github.com/hacs/default` ships JSON files for each
   repo category. ~2-3k repos.
2. **Unlisted "custom repositories"** — users can add any GitHub repo to HACS
   by URL. Discovered via a weekly GitHub code-search for `hacs.json` (the
   manifest file every HACS repo must include), plus user submissions.

Discovered candidates flow through a queue at `/admin/queue`. High-confidence
candidates auto-approve: ≥50 stars *and* pushed within the last 6 months go
straight into the catalogue. Owners that already have a `default`-listed repo
get a lower 5-star bar (trusted-owner discount). Everything else queues for
manual review. Run `pnpm discover` for a single sweep, or
`pnpm discover:bands` to walk 15 file-size bands and break past the GitHub
code-search 1000-result cap.

Catalogued repos move through a lifecycle: `pending` (just added, no scrape
yet) → `active` (default) → `offline` (failing GraphQL) → `removed` (30+ days
offline). GitHub repo renames are picked up via the canonical `nameWithOwner`
field and the row is renamed in place (or deduped against an existing
canonical row).

## Stack

A single-VPS Node app behind Cloudflare-as-CDN.

- **Runtime:** Node 22+, TypeScript end-to-end
- **HTTP:** [Hono](https://hono.dev/) on `@hono/node-server`
- **Database:** SQLite via [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)
  (one file, sync API, fast)
- **Scheduler:** `systemd` timer (no in-process cron)
- **Reverse proxy:** Caddy with `tls internal` (self-signed origin cert, auto-rotated)
- **CDN / TLS / DDoS:** Cloudflare in front (proxied DNS, "Full" SSL — accepts the self-signed origin)
- **Process supervisor:** `systemd` units for `hacs-stats-web` (long-running)
  and `hacs-stats-scrape` (daily timer)
- **Charts:** uPlot or Chart.js (decision deferred to Phase 5)

## Development

Prerequisites: Node 22+, `corepack` (ships with Node).

```sh
# 1. Bootstrap
corepack enable pnpm
pnpm install

# 2. Apply schema to local SQLite (writes to ./data/dev.db)
pnpm migrate

# 3. Run the two apps (two terminals)
pnpm dev:web        # http://localhost:3000
pnpm dev:scraper    # one-shot — runs and exits, like the systemd timer does

# 4. Seed the local DB from the HACS default lists (Phase 2+)
pnpm seed
```

The local SQLite file lives at `./data/dev.db` (gitignored, never auto-wiped).
Snapshot durability matters — see [ARCHITECTURE.md → Local development](./ARCHITECTURE.md#local-development).

### Env vars for operational scripts

The one-off scripts (`pnpm discover`, `pnpm sweep:queue`, `pnpm backfill:queue`,
`pnpm backfill:release-titles`, etc.) need `GITHUB_TOKEN` in the process
environment. They don't auto-load `.env` — load it yourself:

```sh
# Either source per-invocation:
set -a; source .env; set +a; pnpm discover

# Or set up direnv so every cd into the repo exports it:
echo 'dotenv .env' > .envrc && direnv allow
```

The web + scraper `dev:*` scripts and the systemd-managed prod services both
load env separately (tsx watch for dev, `EnvironmentFile=/etc/hacs-stats/env`
for prod); this only matters for the manual `scripts/` entry points.

## Deploy

See [deploy/README.md](./deploy/README.md) for the VPS install steps,
systemd units, Caddyfile, and Cloudflare DNS / Origin Cert setup.

## License

Copyright © John Pettitt.

Licensed under the **GNU Affero General Public License v3.0 or later** —
see [LICENSE](./LICENSE) for the full text.

AGPL is strong copyleft and includes the "network use" clause: anyone who
modifies hacs-stats and runs the modified version as a network service
(e.g. their own dashboard) must offer their users the corresponding
source code under the same license. If that's a problem for your use case,
get in touch.
