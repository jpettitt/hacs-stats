#!/usr/bin/env tsx
/**
 * `pnpm discover:bands` — run discover across size-banded queries so we can
 * break past GitHub's 1000-result cap. Each band is a separate
 * `filename:hacs.json size:LO..HI` search; bands were chosen empirically
 * (see /tmp/probe3.py history) to keep each band comfortably below 1000
 * results.
 *
 * Auto-approve thresholds + AUTOAPPROVE_OFF env are inherited by each band
 * via the spawned `pnpm discover` process.
 *
 * Bands run sequentially — GitHub's code-search limit (30/min) is global
 * across the token, so parallelising bands just buys us 429s.
 */
import { spawn } from 'node:child_process';

const BANDS = [
  'size:<40',
  'size:40..50',
  'size:50..60',
  'size:60..70',
  'size:70..80',
  'size:80..90',
  'size:90..100',
  'size:100..115',
  'size:115..130',
  'size:130..150',
  'size:150..170',
  'size:170..200',
  'size:200..250',
  'size:250..500',
  'size:>500',
];

function runBand(band: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const query = `filename:hacs.json ${band}`;
    console.log(`\n========== ${query} ==========`);
    const child = spawn('pnpm', ['discover'], {
      stdio: 'inherit',
      env: { ...process.env, DISCOVERY_QUERY: query },
    });
    child.on('exit', (code) => {
      if (code === 0) resolve(code);
      else reject(new Error(`band ${band} exited ${code}`));
    });
    child.on('error', reject);
  });
}

async function main(): Promise<void> {
  for (let i = 0; i < BANDS.length; i++) {
    const band = BANDS[i];
    if (!band) continue;
    await runBand(band);
    // Between bands: code-search is 30/min, and each band can burn many
    // search slots (up to 10 search pages + per-candidate raw fetches).
    // 65s lets the bucket refill before the next band starts.
    if (i < BANDS.length - 1) {
      console.log('[discover-bands] sleeping 65s before next band…');
      await new Promise((r) => setTimeout(r, 65_000));
    }
  }
  console.log('\n[discover-bands] all bands done');
}

main().catch((err) => {
  console.error('[discover-bands] failed:', err);
  process.exit(1);
});
