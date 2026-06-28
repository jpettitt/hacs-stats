#!/usr/bin/env tsx
/**
 * Smoke test for the per-day star-history feature.
 *
 * Picks a handful of repos already in the catalogue, fetches their
 * current star count via GitHub GraphQL, then runs fetchAndStoreStarHistory
 * to populate repo_star_history. After it finishes, the repo detail page
 * should render the full curve instead of the 30-day snapshot fallback.
 *
 * Not wired to a pnpm script — intentionally one-shot:
 *   GITHUB_TOKEN=… tsx --env-file-if-exists=.env scripts/smoke-star-history.ts
 */
import { openDb, resolveDatabasePath, runMigrations, starHistory } from '@hacs-stats/db';
import { fetchRepoMetadataBatches } from '../apps/scraper/src/github-graphql.js';
import { fetchAndStoreStarHistory } from '../apps/scraper/src/stargazers.js';

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('GITHUB_TOKEN required');
  process.exit(2);
}

// Mix of small, medium, and large repos so we exercise the per-scrape
// cap path AND the no-op-after-warm path. All present in the dev DB.
const TARGETS = [
  'jpettitt/weather-radar-card',
  'jpettitt/geo-clock-card',
  'jpettitt/purpleair-local',
  'thomasloven/lovelace-card-mod', // large, will cap
  'PiotrMachowski/Home-Assistant-custom-components-Xiaomi-Cloud-Map-Extractor',
];

async function main() {
  const db = openDb({ path: resolveDatabasePath() });
  runMigrations(db);

  const idents = TARGETS.map((fn) => {
    const [owner, name] = fn.split('/');
    return { owner: owner as string, name: name as string };
  });

  console.log(`[smoke] fetching current star counts for ${idents.length} repos…`);
  const metaByName = new Map<string, { stars: number; canonicalFullName: string | null }>();
  for await (const batch of fetchRepoMetadataBatches(idents, { token: TOKEN as string })) {
    for (const m of batch) {
      if (m.stars !== null) metaByName.set(m.fullName, m);
    }
  }

  for (const fullName of TARGETS) {
    const meta = metaByName.get(fullName);
    if (!meta) {
      console.log(`[smoke] ${fullName} — not found on GitHub, skipping`);
      continue;
    }
    const canonical = meta.canonicalFullName ?? fullName;
    const row = db.raw
      .prepare<[string], { id: number }>('SELECT id FROM repos WHERE full_name = ?')
      .get(canonical);
    if (!row) {
      console.log(`[smoke] ${canonical} — not in local DB, skipping`);
      continue;
    }
    const before = starHistory.totalStarsRecorded(db, row.id);
    console.log(
      `[smoke] ${canonical}: GitHub=${meta.stars}, stored=${before}, delta=${meta.stars - before}`,
    );
    const result = await fetchAndStoreStarHistory(db, row.id, canonical, meta.stars, {
      token: TOKEN as string,
      // Smoke test: small cap so this finishes fast even on big repos.
      maxPagesPerScrape: 10,
    });
    const after = starHistory.totalStarsRecorded(db, row.id);
    console.log(
      `[smoke]   → ${result.pagesFetched} pages fetched, ${result.deltaApplied} stars applied, total=${after}${result.truncatedByCap ? ' (CAPPED — re-run to continue)' : ''}`,
    );
  }

  db.close();
  console.log('\n[smoke] done. Visit /r/<owner>/<name> in the browser to see the chart.');
}

main().catch((err) => {
  console.error('[smoke] failed:', err);
  process.exit(1);
});
