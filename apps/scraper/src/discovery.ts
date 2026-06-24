import { fetchHacsManifest } from './hacs-manifest.js';
import { type FetchTextOptions, fetchJson } from './http.js';

/**
 * Custom-repo discovery via GitHub code-search for `filename:hacs.json`.
 *
 * Validation, in order:
 *   1. The hit's `path` must be exactly "hacs.json" — code search matches
 *      anything CONTAINING the filename, so `templates/hacs.json` and
 *      `subdir/hacs.json` slip through. Reject anything off-root.
 *   2. The repo must NOT be a fork — forks are usually low-signal duplicates
 *      and inflate the catalogue with noise.
 *   3. The file's contents must contain at least one HACS-meaningful field.
 *      A file named hacs.json with `{"foo": "bar"}` is almost certainly
 *      coincidental; reject.
 *
 * Returns CandidateRepo entries ready to insert into discovery_queue.
 */

const SEARCH_URL = 'https://api.github.com/search/code';
const USER_AGENT = 'hacs-stats/0.0.0 (+https://hacs-stats.dev)';

const HACS_MEANINGFUL_FIELDS = new Set([
  'name',
  'filename',
  'zip_release',
  'homeassistant',
  'domain',
  'iot_class',
  'country',
  'render_readme',
  'hide_default_branch',
  'content_in_root',
]);

export interface CandidateRepo {
  fullName: string;
  owner: string;
  name: string;
  htmlUrl: string;
}

interface CodeSearchItem {
  name: string;
  path: string;
  repository: {
    full_name: string;
    owner: { login: string };
    name: string;
    html_url: string;
    fork: boolean;
  };
}

interface CodeSearchPage {
  total_count: number;
  incomplete_results: boolean;
  items: CodeSearchItem[];
}

export interface DiscoveryOptions {
  token: string;
  /** Maximum pages of code-search results to walk. GitHub caps at ~1000 results = 10 pages of 100. */
  maxPages?: number;
  /** Inject for tests. */
  fetchImpl?: typeof fetch;
  /** Optional: skip repos whose full_name is already in this set (e.g. existing catalogue). */
  alreadyKnown?: Set<string>;
}

export interface DiscoveryResult {
  candidates: CandidateRepo[];
  inspected: number;
  rejectedNonRoot: number;
  rejectedFork: number;
  rejectedNoMeaningfulFields: number;
  rejectedNoManifest: number;
  alreadyKnown: number;
}

/**
 * Pure validation helper — exported for tests. Given a parsed hacs.json
 * object (or null on fetch failure), report whether it looks like a real
 * HACS manifest.
 */
export function isMeaningfulHacsManifest(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  for (const key of Object.keys(parsed as object)) {
    if (HACS_MEANINGFUL_FIELDS.has(key)) return true;
  }
  return false;
}

export async function discoverCustomRepos(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxPages = opts.maxPages ?? 10;
  const seen = new Set<string>(); // dedupe within this run; one repo may hit on multiple branches/forks
  const alreadyKnown = opts.alreadyKnown ?? new Set();

  const result: DiscoveryResult = {
    candidates: [],
    inspected: 0,
    rejectedNonRoot: 0,
    rejectedFork: 0,
    rejectedNoMeaningfulFields: 0,
    rejectedNoManifest: 0,
    alreadyKnown: 0,
  };

  for (let page = 1; page <= maxPages; page++) {
    const url = `${SEARCH_URL}?q=${encodeURIComponent('filename:hacs.json')}&per_page=100&page=${page}`;
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'User-Agent': USER_AGENT,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      throw new Error(
        `code-search ${res.status} on page ${page}: ${(await res.text()).slice(0, 200)}`,
      );
    }
    const body = (await res.json()) as CodeSearchPage;
    if (body.items.length === 0) break;

    for (const item of body.items) {
      result.inspected++;

      // 1. Root-only filter — code search matches paths CONTAINING the name.
      if (item.path !== 'hacs.json') {
        result.rejectedNonRoot++;
        continue;
      }
      // 2. Fork filter.
      if (item.repository.fork) {
        result.rejectedFork++;
        continue;
      }
      const fullName = item.repository.full_name;
      if (alreadyKnown.has(fullName) || seen.has(fullName)) {
        if (alreadyKnown.has(fullName)) result.alreadyKnown++;
        continue;
      }
      seen.add(fullName);

      // 3. Content filter — must look like a real HACS manifest.
      const manifest = await fetchHacsManifest(fullName, {
        bearerToken: opts.token,
        // Tests inject fetch here. Production omits it → falls back to global.
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      } as FetchTextOptions);
      if (!manifest) {
        result.rejectedNoManifest++;
        continue;
      }
      if (!isMeaningfulHacsManifest(manifest)) {
        result.rejectedNoMeaningfulFields++;
        continue;
      }

      result.candidates.push({
        fullName,
        owner: item.repository.owner.login,
        name: item.repository.name,
        htmlUrl: item.repository.html_url,
      });
    }

    if (body.items.length < 100) break; // last page
  }

  return result;
}

/** Used by /submit POST: same validation rules, but for a single user-supplied repo. */
export interface ValidateSubmissionOptions {
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface SubmissionValidation {
  ok: boolean;
  reason?: 'invalid-name' | 'no-manifest' | 'not-meaningful' | 'fork';
}

const SAFE_PART = /^[A-Za-z0-9._-]+$/;

export function isWellFormedRepoFullName(fullName: string): boolean {
  if (typeof fullName !== 'string') return false;
  if (fullName.length === 0 || fullName.length > 256) return false;
  const slash = fullName.indexOf('/');
  if (slash <= 0 || slash !== fullName.lastIndexOf('/')) return false;
  return SAFE_PART.test(fullName.slice(0, slash)) && SAFE_PART.test(fullName.slice(slash + 1));
}

export async function validateSubmission(
  fullName: string,
  opts: ValidateSubmissionOptions = {},
): Promise<SubmissionValidation> {
  if (!isWellFormedRepoFullName(fullName)) return { ok: false, reason: 'invalid-name' };
  // Check fork status via the REST repo endpoint (cheap, one request).
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetchImpl(`https://api.github.com/repos/${fullName}`, { headers });
  if (res.status === 404) return { ok: false, reason: 'no-manifest' }; // repo doesn't exist
  if (!res.ok) return { ok: false, reason: 'no-manifest' };
  const repo = (await res.json()) as { fork?: boolean };
  if (repo.fork) return { ok: false, reason: 'fork' };
  // hacs.json must exist + be meaningful — reuse the discovery helper.
  const manifest = await fetchHacsManifest(fullName, opts.token ? { bearerToken: opts.token } : {});
  if (!manifest) return { ok: false, reason: 'no-manifest' };
  if (!isMeaningfulHacsManifest(manifest)) return { ok: false, reason: 'not-meaningful' };
  return { ok: true };
}
