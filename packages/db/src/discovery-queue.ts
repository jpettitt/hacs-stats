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

export type SubmissionOutcome =
  | 'inserted' // brand-new row, awaiting review
  | 'promoted' // existing code_search row upgraded to user_submission
  | 'already-pending' // already a user_submission pending row (idempotent)
  | 'already-accepted' // already in the catalogue
  | 'already-rejected'; // admin (or auto-rule) said no — don't resurface

/**
 * Record a /submit POST. Differs from enqueueDiscovery in that a user
 * submitting a repo that ALREADY exists in the queue from code_search
 * promotes the row to source='user_submission' (with a note appended)
 * so the admin sees a human vouched for it — easy to find for review.
 *
 * Returns the outcome so the route handler can surface a useful flash
 * message rather than "thanks!" for cases where nothing actually happened.
 */
export function recordUserSubmission(
  db: Db,
  input: Omit<EnqueueInput, 'source'>,
): SubmissionOutcome {
  const existing = db.raw
    .prepare<[string], { status: DiscoveryStatus; source: DiscoverySource }>(
      'SELECT status, source FROM discovery_queue WHERE url = ?',
    )
    .get(input.url);

  if (!existing) {
    enqueueDiscovery(db, { ...input, source: 'user_submission' });
    return 'inserted';
  }

  if (existing.status === 'accepted') return 'already-accepted';
  if (existing.status === 'rejected') return 'already-rejected';

  // status === 'pending' (or 'error' — treat the same: a human vouch should
  // re-surface it for review). Promote source when it was code_search; if
  // it's already a user_submission, just refresh the fetched metadata.
  if (existing.source === 'user_submission') {
    db.raw
      .prepare(
        'UPDATE discovery_queue SET stars = COALESCE(?, stars), pushed_at = COALESCE(?, pushed_at), description = COALESCE(?, description) WHERE url = ?',
      )
      .run(input.stars ?? null, input.pushedAt ?? null, input.description ?? null, input.url);
    return 'already-pending';
  }

  db.raw
    .prepare(
      `UPDATE discovery_queue
       SET source = 'user_submission',
           notes  = COALESCE(notes, '') || '; promoted by user submission' || COALESCE(' (' || ? || ')', ''),
           stars  = COALESCE(?, stars),
           pushed_at = COALESCE(?, pushed_at),
           description = COALESCE(?, description)
       WHERE url = ?`,
    )
    .run(
      input.notes ?? null,
      input.stars ?? null,
      input.pushedAt ?? null,
      input.description ?? null,
      input.url,
    );
  return 'promoted';
}

/** Sort options exposed by the admin queue UI. NULLs are pushed to the end
 * in both directions so pre-migration rows don't dominate the top of any
 * sort (their stars/pushed_at are unknown, not zero / forever-ago). */
export type QueueSort = 'discovered' | 'stars' | 'pushed';
export type SortDir = 'asc' | 'desc';

export function listQueueByStatus(
  db: Db,
  status: DiscoveryStatus,
  limit = 50,
  sort: QueueSort = 'discovered',
  dir: SortDir = 'desc',
  offset = 0,
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
    .prepare<[DiscoveryStatus, number, number], QueueItem>(
      `SELECT url, source, discovered_at, status, notes, stars, pushed_at, description
       FROM discovery_queue WHERE status = ?
       ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    )
    .all(status, limit, offset);
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
