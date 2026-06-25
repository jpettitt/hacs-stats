import type { Db } from './client.js';

export type DiscoverySource = 'code_search' | 'user_submission' | 'forum_scrape';
export type DiscoveryStatus = 'pending' | 'accepted' | 'rejected' | 'error';

export interface QueueItem {
  url: string;
  source: DiscoverySource;
  discovered_at: string;
  status: DiscoveryStatus;
  notes: string | null;
  /** Stars at enqueue time. Null for rows enqueued before migration 0009
   * or when the REST lookup failed at discovery time. */
  stars: number | null;
  /** ISO `pushed_at` from GitHub at enqueue time. Same caveat as stars. */
  pushed_at: string | null;
  /** GitHub repo description at enqueue time. Same caveat as stars. */
  description: string | null;
}

export interface EnqueueInput {
  url: string;
  source: DiscoverySource;
  notes?: string | null;
  stars?: number | null;
  pushedAt?: string | null;
  description?: string | null;
}

export function enqueueDiscovery(db: Db, input: EnqueueInput): boolean {
  const res = db.raw
    .prepare(
      `INSERT INTO discovery_queue (url, source, discovered_at, status, notes, stars, pushed_at, description)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
       ON CONFLICT(url) DO NOTHING`,
    )
    .run(
      input.url,
      input.source,
      new Date().toISOString(),
      input.notes ?? null,
      input.stars ?? null,
      input.pushedAt ?? null,
      input.description ?? null,
    );
  return res.changes > 0;
}

/** Sort options exposed by the admin queue UI. NULLs are pushed to the end
 * in both directions so pre-migration rows don't dominate the top of any
 * sort (their stars/pushed_at are unknown, not zero / forever-ago). */
export type QueueSort = 'discovered' | 'stars' | 'pushed';
export type SortDir = 'asc' | 'desc';

export function listQueueByStatus(
  db: Db,
  status: DiscoveryStatus,
  limit = 200,
  sort: QueueSort = 'discovered',
  dir: SortDir = 'desc',
): QueueItem[] {
  const dirSql = dir === 'asc' ? 'ASC' : 'DESC';
  // CASE-WHEN keeps NULLs at the END regardless of direction. SQLite sorts
  // NULLs first by default, which would put unknown-stars rows ahead of
  // 50k-star rows when sorting desc — surprising and wrong.
  const orderBy =
    sort === 'stars'
      ? `CASE WHEN stars IS NULL THEN 1 ELSE 0 END, stars ${dirSql}, discovered_at DESC`
      : sort === 'pushed'
        ? `CASE WHEN pushed_at IS NULL THEN 1 ELSE 0 END, pushed_at ${dirSql}, discovered_at DESC`
        : `discovered_at ${dirSql}`;
  return db.raw
    .prepare<[DiscoveryStatus, number], QueueItem>(
      `SELECT url, source, discovered_at, status, notes, stars, pushed_at, description
       FROM discovery_queue WHERE status = ?
       ORDER BY ${orderBy} LIMIT ?`,
    )
    .all(status, limit);
}

export function countQueueByStatus(db: Db): Record<DiscoveryStatus, number> {
  const rows = db.raw
    .prepare<[], { status: DiscoveryStatus; n: number }>(
      'SELECT status, COUNT(*) AS n FROM discovery_queue GROUP BY status',
    )
    .all();
  const out: Record<DiscoveryStatus, number> = {
    pending: 0,
    accepted: 0,
    rejected: 0,
    error: 0,
  };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export function setQueueStatus(
  db: Db,
  url: string,
  status: DiscoveryStatus,
  notes?: string | null,
): boolean {
  const res = db.raw
    .prepare('UPDATE discovery_queue SET status = ?, notes = ? WHERE url = ?')
    .run(status, notes ?? null, url);
  return res.changes > 0;
}
