import type { Db } from './client.js';

export type DiscoverySource = 'code_search' | 'user_submission' | 'forum_scrape';
export type DiscoveryStatus = 'pending' | 'accepted' | 'rejected' | 'error';

export interface QueueItem {
  url: string;
  source: DiscoverySource;
  discovered_at: string;
  status: DiscoveryStatus;
  notes: string | null;
}

export interface EnqueueInput {
  url: string;
  source: DiscoverySource;
  notes?: string | null;
}

export function enqueueDiscovery(db: Db, input: EnqueueInput): boolean {
  const res = db.raw
    .prepare(
      `INSERT INTO discovery_queue (url, source, discovered_at, status, notes)
       VALUES (?, ?, ?, 'pending', ?)
       ON CONFLICT(url) DO NOTHING`,
    )
    .run(input.url, input.source, new Date().toISOString(), input.notes ?? null);
  return res.changes > 0;
}

export function listQueueByStatus(db: Db, status: DiscoveryStatus, limit = 200): QueueItem[] {
  return db.raw
    .prepare<[DiscoveryStatus, number], QueueItem>(
      `SELECT url, source, discovered_at, status, notes
       FROM discovery_queue WHERE status = ?
       ORDER BY discovered_at DESC LIMIT ?`,
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
