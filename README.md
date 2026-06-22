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

## Deploy

See [deploy/README.md](./deploy/README.md) for the VPS install steps,
systemd units, Caddyfile, and Cloudflare DNS / Origin Cert setup.

## Copyright

Copyright © John Pettitt. All rights reserved. Closed source — no license is
granted to copy, modify, distribute, or use this code.
