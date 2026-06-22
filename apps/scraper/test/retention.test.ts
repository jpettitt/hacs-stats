import { openDb, releases, repos, runMigrations, snapshots } from '@hacs-stats/db';
import { describe, expect, it } from 'vitest';
import { applyRetention } from '../src/retention.js';

function freshDb() {
  const db = openDb({ path: ':memory:' });
  runMigrations(db);
  return db;
}

function seedRepo(db: ReturnType<typeof freshDb>): number {
  return repos.upsertRepo(db, { owner: 'a', name: 'b', kind: 'plugin', source: 'default' });
}

function seedDailySnapshots(
  db: ReturnType<typeof freshDb>,
  repoId: number,
  fromIsoDate: string,
  days: number,
) {
  const base = new Date(`${fromIsoDate}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    const d = new Date(base.getTime() + i * 86_400_000);
    const date = d.toISOString().slice(0, 10);
    snapshots.upsertRepoSnapshot(db, {
      repoId,
      snapshotDate: date,
      stars: 100 + i,
      forks: 0,
      openIssues: 0,
      lastCommitAt: null,
    });
  }
}

describe('applyRetention — repo_snapshots', () => {
  it('keeps everything inside the daily window', () => {
    const db = freshDb();
    const r = seedRepo(db);
    seedDailySnapshots(db, r, '2026-04-22', 60); // last 60d up to 2026-06-21
    const result = applyRetention(db, { asOfDate: '2026-06-21' });
    expect(result.repoSnapshotsDeleted).toBe(0);
  });

  it('collapses old daily snapshots to one row per ISO week', () => {
    const db = freshDb();
    const r = seedRepo(db);
    // 30 days of snapshots starting Jan 1 — well past 90d cutoff for asOf Jun 21.
    seedDailySnapshots(db, r, '2026-01-01', 30);
    const result = applyRetention(db, { asOfDate: '2026-06-21' });
    expect(result.repoSnapshotsDeleted).toBeGreaterThan(0);

    // 30 days spans ~5 ISO weeks; keep one snapshot per (repo_id, ISO-week).
    // Single-quotes around the strftime format — SQLite reads "..." as an
    // identifier (column name) and complains otherwise.
    const remaining = db.raw
      .prepare(
        `SELECT COUNT(DISTINCT strftime('%Y-%W', snapshot_date)) AS weeks, COUNT(*) AS rows FROM repo_snapshots`,
      )
      .get() as { weeks: number; rows: number };
    expect(remaining.rows).toBe(remaining.weeks);
    expect(remaining.weeks).toBeGreaterThanOrEqual(4);
    expect(remaining.weeks).toBeLessThanOrEqual(6);
  });

  it('the survivor of each week is the LATEST snapshot in that week', () => {
    const db = freshDb();
    const r = seedRepo(db);
    // Mon 2026-01-05 + 14 days = exactly two full ISO weeks (Mon-Sun, Mon-Sun).
    // Per week, the survivor should be the Sunday row.
    seedDailySnapshots(db, r, '2026-01-05', 14);
    applyRetention(db, { asOfDate: '2026-06-21' });

    const rows = db.raw
      .prepare('SELECT snapshot_date FROM repo_snapshots ORDER BY snapshot_date')
      .all() as { snapshot_date: string }[];
    expect(rows.length).toBe(2);
    for (const r of rows) {
      const d = new Date(`${r.snapshot_date}T00:00:00Z`).getUTCDay();
      expect(d).toBe(0); // Sunday
    }
  });

  it('boundary: snapshot exactly at the threshold is kept (daily side)', () => {
    const db = freshDb();
    const r = seedRepo(db);
    // 91 days before asOf — 1 day older than the 90-day daily threshold,
    // so it should be a candidate for collapse. The 90-day-old one should
    // stay because it's within the window.
    seedDailySnapshots(db, r, '2026-03-22', 1); // 91 days before Jun 21
    seedDailySnapshots(db, r, '2026-03-23', 1); // 90 days before Jun 21
    applyRetention(db, { asOfDate: '2026-06-21' });
    const remaining = db.raw
      .prepare('SELECT snapshot_date FROM repo_snapshots ORDER BY snapshot_date')
      .all() as { snapshot_date: string }[];
    // 2026-03-22 was a Sunday in our seed and is the latest in its ISO week,
    // so it survives as the weekly representative. 2026-03-23 stays as
    // in-window. Both should be present.
    expect(remaining.map((r) => r.snapshot_date)).toEqual(['2026-03-22', '2026-03-23']);
  });
});

describe('applyRetention — release_asset_snapshots', () => {
  it('collapses old asset snapshots independently (30d threshold)', () => {
    const db = freshDb();
    const r = seedRepo(db);
    const rel = releases.upsertRelease(db, {
      repoId: r,
      tag: 'v1',
      publishedAt: '2026-01-01T00:00:00Z',
      isPrerelease: false,
      htmlUrl: '',
    });
    // 14 daily snapshots starting Mon 2026-01-05 — well past the 30d cutoff
    // for Jun 21, and the start is a Monday so the 14 days line up to
    // exactly two full ISO weeks (week 01 + week 02). One row per week,
    // expected = 2.
    for (let i = 0; i < 14; i++) {
      const d = new Date(Date.UTC(2026, 0, 5 + i));
      releases.upsertReleaseAssetSnapshot(db, {
        releaseId: rel,
        assetName: 'card.js',
        snapshotDate: d.toISOString().slice(0, 10),
        downloadCount: 100 + i,
      });
    }
    const result = applyRetention(db, { asOfDate: '2026-06-21' });
    expect(result.assetSnapshotsDeleted).toBeGreaterThan(0);

    const remaining = db.raw.prepare('SELECT COUNT(*) AS n FROM release_asset_snapshots').get() as {
      n: number;
    };
    expect(remaining.n).toBe(2);
  });
});
