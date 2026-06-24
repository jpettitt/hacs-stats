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

export interface SetHacsManifestInput {
  fullName: string;
  hacsFilename: string | null;
  hacsName: string | null;
}

export function setHacsManifest(db: Db, input: SetHacsManifestInput): void {
  db.raw
    .prepare(
      'UPDATE repos SET hacs_filename = ?, hacs_name = ?, last_scraped_at = ? WHERE full_name = ?',
    )
    .run(input.hacsFilename, input.hacsName, new Date().toISOString(), input.fullName);
}

/** Kept under the old name for tests that haven't migrated yet. */
export function setHacsFilename(
  db: Db,
  input: { fullName: string; hacsFilename: string | null },
): void {
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
  // Distinguish "no limit" (undefined) from "limit zero" (0). The earlier
  // `limit ? …` form treated both as "no limit", which surprised callers
  // who passed SCRAPE_LIMIT=0 expecting zero repos.
  if (limit === undefined) {
    return db.raw
      .prepare<[], AllRepoIdent>('SELECT id, owner, name, full_name FROM repos ORDER BY id')
      .all();
  }
  return db.raw
    .prepare<[number], AllRepoIdent>(
      'SELECT id, owner, name, full_name FROM repos ORDER BY id LIMIT ?',
    )
    .all(limit);
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

export interface UpdateRepoMetadataInput {
  repoId: number;
  description: string | null;
  archived: boolean;
  isFork: boolean;
  defaultBranch: string | null;
}

/**
 * Persist the slow-moving fields GraphQL returns on every batch. The fast-
 * moving ones (stars, forks, issues) go into repo_snapshots; these belong on
 * the repos row itself because they're effectively properties of the repo,
 * not a daily measurement.
 *
 * Was missed in the original Phase 3 wiring — the scraper fetched these
 * fields but only wrote the snapshot, leaving `description` empty
 * everywhere the UI surfaced it.
 */
export function updateRepoMetadata(db: Db, input: UpdateRepoMetadataInput): void {
  db.raw
    .prepare(
      'UPDATE repos SET description = ?, archived = ?, is_fork = ?, default_branch = ? WHERE id = ?',
    )
    .run(
      input.description,
      input.archived ? 1 : 0,
      input.isFork ? 1 : 0,
      input.defaultBranch,
      input.repoId,
    );
}

export interface CategoryCount {
  kind: string;
  n: number;
}

export function categoryCounts(db: Db): CategoryCount[] {
  return db.raw
    .prepare<[], CategoryCount>(
      'SELECT kind, COUNT(*) AS n FROM repos GROUP BY kind ORDER BY n DESC',
    )
    .all();
}

/**
 * `q` is a user-supplied substring. We use LIKE rather than FTS5 — for ~3k
 * rows it's instantaneous, and we avoid maintaining a separate FTS index.
 * Promote to FTS5 if the catalogue grows past ~50k.
 *
 * The `escape '\\'` clause lets us literal-match user-supplied % and _ chars
 * by escaping them before binding.
 */
export function searchRepos(db: Db, q: string, limit = 30): Repo[] {
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  const needle = `%${escaped}%`;
  return db.raw
    .prepare<[string, string, number], Repo>(
      `SELECT * FROM repos
        WHERE (full_name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
        ORDER BY full_name
        LIMIT ?`,
    )
    .all(needle, needle, limit);
}
