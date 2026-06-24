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

/**
 * Record a successful scrape: bumps last_scraped_at, clears failure
 * counters, transitions state to 'active' (even from 'offline' / 'removed' —
 * recovery is allowed).
 */
export function markRepoSuccess(db: Db, repoId: number): void {
  db.raw
    .prepare(
      `UPDATE repos
          SET last_scraped_at = ?,
              state = 'active',
              first_failure_at = NULL,
              consecutive_failures = 0
        WHERE id = ?`,
    )
    .run(new Date().toISOString(), repoId);
}

export type FailureOutcome =
  | { action: 'kept'; newState: 'pending' | 'active' | 'offline' | 'removed' }
  | { action: 'deleted' };

/**
 * Record a failed scrape (repo missing on GitHub) and advance state:
 *   pending  + 1st fail → pending (consecutive_failures=1)
 *   pending  + 2nd fail → DELETE the row + cascades (caller resubmits)
 *   active   + fail     → offline, first_failure_at=now
 *   offline + fail (≥ removedAfterDays old) → removed
 *   offline + fail (newer)                   → offline (counter bumps)
 *   removed                                  → no-op
 */
export function markRepoFailure(
  db: Db,
  repoId: number,
  opts: { removedAfterDays?: number; now?: Date } = {},
): FailureOutcome {
  const now = opts.now ?? new Date();
  const removedAfter = opts.removedAfterDays ?? 30;
  const row = db.raw
    .prepare<
      [number],
      { state: string; first_failure_at: string | null; consecutive_failures: number }
    >('SELECT state, first_failure_at, consecutive_failures FROM repos WHERE id = ?')
    .get(repoId);
  if (!row) return { action: 'kept', newState: 'active' };

  if (row.state === 'pending') {
    if (row.consecutive_failures >= 1) {
      deleteRepoCascade(db, repoId);
      return { action: 'deleted' };
    }
    db.raw
      .prepare(
        `UPDATE repos SET consecutive_failures = consecutive_failures + 1,
                          first_failure_at = COALESCE(first_failure_at, ?)
                    WHERE id = ?`,
      )
      .run(now.toISOString(), repoId);
    return { action: 'kept', newState: 'pending' };
  }

  if (row.state === 'active') {
    db.raw
      .prepare(
        `UPDATE repos SET state = 'offline',
                          first_failure_at = ?,
                          consecutive_failures = 1
                    WHERE id = ?`,
      )
      .run(now.toISOString(), repoId);
    return { action: 'kept', newState: 'offline' };
  }

  if (row.state === 'offline') {
    const firstFailMs = row.first_failure_at ? Date.parse(row.first_failure_at) : Number.NaN;
    const ageMs = Number.isFinite(firstFailMs) ? now.getTime() - firstFailMs : 0;
    const thresholdMs = removedAfter * 24 * 60 * 60 * 1000;
    if (ageMs >= thresholdMs) {
      db.raw
        .prepare(
          `UPDATE repos SET state = 'removed',
                            consecutive_failures = consecutive_failures + 1
                      WHERE id = ?`,
        )
        .run(repoId);
      return { action: 'kept', newState: 'removed' };
    }
    db.raw
      .prepare('UPDATE repos SET consecutive_failures = consecutive_failures + 1 WHERE id = ?')
      .run(repoId);
    return { action: 'kept', newState: 'offline' };
  }

  return { action: 'kept', newState: 'removed' as const };
}

/**
 * Rename a repo in place (used when GitHub returns a canonical name
 * different from the request — the repo was moved/renamed on GitHub).
 * Updates owner / name / full_name, preserves id and all referenced
 * snapshots/releases. Returns failure when the new name already lives
 * elsewhere in the catalogue (the caller should delete the old as a
 * duplicate).
 */
export function renameRepo(
  db: Db,
  repoId: number,
  newFullName: string,
): { ok: true } | { ok: false; reason: 'duplicate' | 'malformed' } {
  const slash = newFullName.indexOf('/');
  if (slash <= 0 || slash !== newFullName.lastIndexOf('/')) {
    return { ok: false, reason: 'malformed' };
  }
  const owner = newFullName.slice(0, slash);
  const name = newFullName.slice(slash + 1);
  if (!owner || !name) return { ok: false, reason: 'malformed' };

  const conflict = db.raw
    .prepare<[string, number], { id: number }>(
      'SELECT id FROM repos WHERE full_name = ? AND id != ?',
    )
    .get(newFullName, repoId);
  if (conflict) return { ok: false, reason: 'duplicate' };

  db.raw
    .prepare('UPDATE repos SET owner = ?, name = ?, full_name = ? WHERE id = ?')
    .run(owner, name, newFullName, repoId);
  return { ok: true };
}

/**
 * Delete a repo and all dependent rows. Children are wired via REFERENCES /
 * ON DELETE CASCADE in the schema, but we wipe them explicitly too in case
 * older migrations didn't include the cascade. Wrapped in a single tx.
 */
export function deleteRepoCascade(db: Db, repoId: number): void {
  const tx = db.raw.transaction(() => {
    db.raw
      .prepare(
        'DELETE FROM release_asset_snapshots WHERE release_id IN (SELECT id FROM releases WHERE repo_id = ?)',
      )
      .run(repoId);
    db.raw.prepare('DELETE FROM releases WHERE repo_id = ?').run(repoId);
    db.raw.prepare('DELETE FROM repo_snapshots WHERE repo_id = ?').run(repoId);
    db.raw.prepare('DELETE FROM stats_cache WHERE repo_id = ?').run(repoId);
    db.raw.prepare('DELETE FROM repos WHERE id = ?').run(repoId);
  });
  tx();
}

/** Find other repos in our catalogue owned by the same GitHub user/org —
 * used by /admin/queue to surface 'related projects' alongside each
 * candidate. Excludes the repo being queried so the row doesn't list itself. */
export function listRepoIdentsByOwner(
  db: Db,
  owner: string,
  excludeFullName?: string,
): Array<{ full_name: string; hacs_name: string | null; kind: string }> {
  if (excludeFullName) {
    return db.raw
      .prepare<[string, string], { full_name: string; hacs_name: string | null; kind: string }>(
        'SELECT full_name, hacs_name, kind FROM repos WHERE owner = ? AND full_name != ? ORDER BY full_name',
      )
      .all(owner, excludeFullName);
  }
  return db.raw
    .prepare<[string], { full_name: string; hacs_name: string | null; kind: string }>(
      'SELECT full_name, hacs_name, kind FROM repos WHERE owner = ? ORDER BY full_name',
    )
    .all(owner);
}

export interface UpdateRepoMetadataInput {
  repoId: number;
  description: string | null;
  archived: boolean;
  isFork: boolean;
  /** For forks, "owner/name" of the upstream repo. Null for non-forks. */
  parentFullName: string | null;
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
      `UPDATE repos
          SET description = ?, archived = ?, is_fork = ?,
              parent_full_name = ?, default_branch = ?
        WHERE id = ?`,
    )
    .run(
      input.description,
      input.archived ? 1 : 0,
      input.isFork ? 1 : 0,
      input.parentFullName,
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
