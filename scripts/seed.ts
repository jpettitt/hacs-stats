#!/usr/bin/env tsx
/**
 * `pnpm seed` — wrapper that runs the same code path as `pnpm dev:scraper`.
 * Kept as a separate entrypoint so the README's "bootstrap" steps stay
 * conceptually distinct from "run a scrape", even though they're the same
 * thing today.
 */
await import('../apps/scraper/src/index.js');
