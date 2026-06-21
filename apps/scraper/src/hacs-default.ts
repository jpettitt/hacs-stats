import { REPO_KINDS, type RepoKind } from '@hacs-stats/shared';
import { type FetchTextOptions, fetchJson } from './http.js';

/** Use `HEAD` so we don't care whether the upstream default branch is master/main/whatever. */
const BASE = 'https://raw.githubusercontent.com/hacs/default/HEAD';

export interface DefaultListEntry {
  kind: RepoKind;
  owner: string;
  name: string;
  /** "owner/name" — what HACS uses as the canonical identifier. */
  fullName: string;
}

/**
 * Fetch one HACS default-list file. The on-disk format is a JSON array of
 * "owner/repo" strings. We defensively skip anything that isn't a non-empty
 * string with one slash — upstream has had bad entries historically.
 */
export async function fetchDefaultList(
  kind: RepoKind,
  opts: FetchTextOptions = {},
): Promise<DefaultListEntry[]> {
  const raw = await fetchJson<unknown>(`${BASE}/${kind}`, opts);
  if (!Array.isArray(raw)) {
    throw new Error(`fetchDefaultList(${kind}): expected JSON array, got ${typeof raw}`);
  }
  const out: DefaultListEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const slash = entry.indexOf('/');
    if (slash <= 0 || slash === entry.length - 1) continue;
    const owner = entry.slice(0, slash);
    const name = entry.slice(slash + 1);
    if (!owner || !name || name.includes('/')) continue;
    out.push({ kind, owner, name, fullName: entry });
  }
  return out;
}

export interface AllDefaultListsResult {
  entries: DefaultListEntry[];
  byKind: Record<RepoKind, number>;
}

/** Fetch all 7 default lists in parallel. Throws if any single list fails. */
export async function fetchAllDefaultLists(
  opts: FetchTextOptions = {},
): Promise<AllDefaultListsResult> {
  const lists = await Promise.all(REPO_KINDS.map((k) => fetchDefaultList(k, opts)));
  const entries = lists.flat();
  const byKind = Object.fromEntries(REPO_KINDS.map((k, i) => [k, lists[i]?.length ?? 0])) as Record<
    RepoKind,
    number
  >;
  return { entries, byKind };
}
