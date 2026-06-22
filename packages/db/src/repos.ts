import type { Repo, RepoKind, RepoSource } from '@hacs-stats/shared';
import type { Db } from './client.js';

export function countRepos(db: Db): number {
  const row = db.raw.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM repos').get();
  return row?.n ?? 0;
}

export function countReposByKind(db: Db): Map<RepoKind, number> {
  const rows = db.raw
    .prepare<[], { kind: RepoKind; n: number }>(
      'SELECT kind, COUNT(*) AS n FROM repos GROUP BY kind',
    )
    .all();
  return new Map(rows.map((r) => [r.kind, r.n]));
}

export function getRepoByFullName(db: Db, fullName: string): Repo | undefined {
  return db.raw.prepare<[string], Repo>('SELECT * FROM repos WHERE full_name = ?').get(fullName);
}

export interface UpsertRepoInput {
  owner: string;
  name: string;
  kind: RepoKind;
  source: RepoSource;
}

/**
 * Insert a repo by `full_name`, or — if it already exists — refresh its `kind`
 * and `source` (a repo can be re-categorised by upstream). Returns the row id.
 *
 * Does NOT touch `hacs_filename`, `description`, `archived`, `default_branch`,
 * `last_scraped_at` — those come from later scrape steps and we don't want to
 * blow them away on a default-list refresh.
 *
 * Idempotent. Designed to be called inside a transaction for batch upserts.
 */
export function upsertRepo(db: Db, input: UpsertRepoInput): number {
  const fullName = `${input.owner}/${input.name}`;
  const nowIso = new Date().toISOString();

  const stmt = db.raw.prepare<[string, string, string, string, string, string], { id: number }>(`
    INSERT INTO repos (owner, name, full_name, kind, source, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(full_name) DO UPDATE SET
      kind   = excluded.kind,
      source = excluded.source
    RETURNING id
  `);

  const row = stmt.get(input.owner, input.name, fullName, input.kind, input.source, nowIso);
  if (!row) throw new Error(`upsertRepo: no row returned for ${fullName}`);
  return row.id;
}

export interface SetHacsFilenameInput {
  fullName: string;
  hacsFilename: string | null;
}

export function setHacsFilename(db: Db, input: SetHacsFilenameInput): void {
  db.raw
    .prepare('UPDATE repos SET hacs_filename = ?, last_scraped_at = ? WHERE full_name = ?')
    .run(input.hacsFilename, new Date().toISOString(), input.fullName);
}

export interface AllRepoIdent {
  id: number;
  owner: string;
  name: string;
  full_name: string;
}

export function listAllRepoIdents(db: Db, limit?: number): AllRepoIdent[] {
  const sql = limit
    ? 'SELECT id, owner, name, full_name FROM repos ORDER BY id LIMIT ?'
    : 'SELECT id, owner, name, full_name FROM repos ORDER BY id';
  const stmt = db.raw.prepare<number[], AllRepoIdent>(sql);
  return limit ? stmt.all(limit) : stmt.all();
}

export function getReleasesEtag(db: Db, repoId: number): string | null {
  const row = db.raw
    .prepare<[number], { releases_etag: string | null }>(
      'SELECT releases_etag FROM repos WHERE id = ?',
    )
    .get(repoId);
  return row?.releases_etag ?? null;
}

export function setReleasesEtag(db: Db, repoId: number, etag: string | null): void {
  db.raw.prepare('UPDATE repos SET releases_etag = ? WHERE id = ?').run(etag, repoId);
}

export function markScraped(db: Db, repoId: number): void {
  db.raw
    .prepare('UPDATE repos SET last_scraped_at = ? WHERE id = ?')
    .run(new Date().toISOString(), repoId);
}
