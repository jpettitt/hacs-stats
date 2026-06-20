import type { Repo } from '@hacs-stats/shared';
import type { Db } from './client.js';

export function countRepos(db: Db): number {
  const row = db.raw.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM repos').get();
  return row?.n ?? 0;
}

export function getRepoByFullName(db: Db, fullName: string): Repo | undefined {
  return db.raw.prepare<[string], Repo>('SELECT * FROM repos WHERE full_name = ?').get(fullName);
}
