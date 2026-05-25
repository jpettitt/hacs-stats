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
> **Status:** v0 — design phase. No code yet. See [ARCHITECTURE.md](./ARCHITECTURE.md)
> for the design and [TODO.md](./TODO.md) for the phased build plan.

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

- **Cloudflare Workers** for the scraper, API, and SSR frontend
- **Cloudflare D1** (SQLite) for the database
- **Cloudflare Cron Triggers** for the daily scrape
- **Cloudflare Pages** for the static dashboard assets
- **TypeScript** end-to-end, **Hono** for routing, **uPlot** or **Chart.js**
  for charts

## License

TBD.
