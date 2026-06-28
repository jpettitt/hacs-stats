import type { Db } from './client.js';

export interface UpsertReleaseInput {
  repoId: number;
  tag: string;
  /** GitHub release "name" field — nullable; many authors leave it blank. */
  name?: string | null;
  /** Release notes markdown body. Used to derive a display title when
   * `name` is blank. Capped on insert via UI-side excerpting; we store
   * the full text here. */
  body?: string | null;
  publishedAt: string;
  isPrerelease: boolean;
  htmlUrl: string;
}

/**
 * Insert a release, or update its mutable fields if it already exists.
 * `tag` + `repo_id` are the natural key.
 *
 * Returns the row id. better-sqlite3's RETURNING was added in v9 — we ship 11.
 */
export function upsertRelease(db: Db, input: UpsertReleaseInput): number {
  const row = db.raw
    .prepare<
      [number, string, string | null, string | null, string, number, string],
      { id: number }
    >(`
      INSERT INTO releases (repo_id, tag, name, body, published_at, is_prerelease, html_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, tag) DO UPDATE SET
        name          = excluded.name,
        body          = excluded.body,
        published_at  = excluded.published_at,
        is_prerelease = excluded.is_prerelease,
        html_url      = excluded.html_url
      RETURNING id
    `)
    .get(
      input.repoId,
      input.tag,
      input.name ?? null,
      input.body ?? null,
      input.publishedAt,
      input.isPrerelease ? 1 : 0,
      input.htmlUrl,
    );
  if (!row) throw new Error(`upsertRelease: no row returned for ${input.repoId}/${input.tag}`);
  return row.id;
}

export interface UpsertReleaseAssetSnapshotInput {
  releaseId: number;
  assetName: string;
  snapshotDate: string; // YYYY-MM-DD (UTC)
  downloadCount: number;
}

export function upsertReleaseAssetSnapshot(db: Db, input: UpsertReleaseAssetSnapshotInput): void {
  db.raw
    .prepare(`
      INSERT INTO release_asset_snapshots
        (release_id, asset_name, snapshot_date, download_count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(release_id, asset_name, snapshot_date) DO UPDATE SET
        download_count = excluded.download_count
    `)
    .run(input.releaseId, input.assetName, input.snapshotDate, input.downloadCount);
}

export function countReleasesForRepo(db: Db, repoId: number): number {
  const row = db.raw
    .prepare<[number], { n: number }>('SELECT COUNT(*) AS n FROM releases WHERE repo_id = ?')
    .get(repoId);
  return row?.n ?? 0;
}

export function countAssetSnapshotsForDate(db: Db, snapshotDate: string): number {
  const row = db.raw
    .prepare<[string], { n: number }>(
      'SELECT COUNT(*) AS n FROM release_asset_snapshots WHERE snapshot_date = ?',
    )
    .get(snapshotDate);
  return row?.n ?? 0;
}
