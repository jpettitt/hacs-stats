/**
 * Submission validation for /submit POST. Same rules the discovery worker
 * uses, kept in the web package because that's where the form lives and
 * the scraper isn't on the web process's runtime path.
 */

const USER_AGENT = 'hacs-stats/0.0.0 (+https://hacs-stats.dev)';
const SAFE_PART = /^[A-Za-z0-9._-]+$/;

/** Mirrors SUPPRESSED_FULLNAMES in apps/scraper/src/discovery.ts —
 * platform repos (hacs/integration etc) we explicitly don't want in the
 * catalogue. Kept in sync by hand; both are short lists. */
const SUPPRESSED_FULLNAMES = new Set<string>(['hacs/integration']);

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

export function isWellFormedRepoFullName(fullName: string): boolean {
  if (typeof fullName !== 'string') return false;
  if (fullName.length === 0 || fullName.length > 256) return false;
  const slash = fullName.indexOf('/');
  if (slash <= 0 || slash !== fullName.lastIndexOf('/')) return false;
  return SAFE_PART.test(fullName.slice(0, slash)) && SAFE_PART.test(fullName.slice(slash + 1));
}

export function isMeaningfulHacsManifest(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  for (const key of Object.keys(parsed as object)) {
    if (HACS_MEANINGFUL_FIELDS.has(key)) return true;
  }
  return false;
}

export type SubmissionFailure =
  | 'invalid-name'
  | 'repo-not-found'
  | 'private-or-removed'
  | 'no-hacs-json'
  | 'malformed-hacs-json'
  | 'not-meaningful'
  | 'suppressed'
  | 'stale'
  // Forks are allowed via submission (the submitter is vouching for it as
  // the real canonical), but if the submitted repo is a fork we still
  // record it so the admin sees the lineage.
  | 'network-error';

/** Mirrors STALE_MS in apps/scraper/src/discovery.ts and the 3-year
 * listing filter in packages/db/src/leaders.ts — no point accepting a
 * submission for a repo we'd hide on render. */
const STALE_MS = 3 * 365 * 24 * 60 * 60 * 1000;

export interface SubmissionResult {
  ok: boolean;
  failure?: SubmissionFailure | undefined;
  /** Pre-checked when ok — surfaces in the admin queue notes column. */
  notes?: string | undefined;
}

export interface ValidateSubmissionOptions {
  token?: string | undefined;
  fetchImpl?: typeof fetch;
}

export async function validateSubmission(
  fullName: string,
  opts: ValidateSubmissionOptions = {},
): Promise<SubmissionResult> {
  if (!isWellFormedRepoFullName(fullName)) return { ok: false, failure: 'invalid-name' };
  if (SUPPRESSED_FULLNAMES.has(fullName.toLowerCase())) {
    return { ok: false, failure: 'suppressed' };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  // 1. Repo exists + is public.
  let repoRes: Response;
  try {
    repoRes = await fetchImpl(`https://api.github.com/repos/${fullName}`, { headers });
  } catch {
    return { ok: false, failure: 'network-error' };
  }
  if (repoRes.status === 404) return { ok: false, failure: 'repo-not-found' };
  if (repoRes.status === 403 || repoRes.status === 451) {
    return { ok: false, failure: 'private-or-removed' };
  }
  if (!repoRes.ok) return { ok: false, failure: 'network-error' };
  const repo = (await repoRes.json()) as {
    fork?: boolean;
    full_name?: string;
    pushed_at?: string;
  };
  if (typeof repo.pushed_at === 'string') {
    const pushedMs = Date.parse(repo.pushed_at);
    if (Number.isFinite(pushedMs) && Date.now() - pushedMs > STALE_MS) {
      return { ok: false, failure: 'stale' };
    }
  }

  // 2. hacs.json must exist at the root and parse.
  let hacsRes: Response;
  try {
    hacsRes = await fetchImpl(`https://raw.githubusercontent.com/${fullName}/HEAD/hacs.json`, {
      headers: { 'User-Agent': USER_AGENT },
    });
  } catch {
    return { ok: false, failure: 'network-error' };
  }
  if (hacsRes.status === 404) return { ok: false, failure: 'no-hacs-json' };
  if (!hacsRes.ok) return { ok: false, failure: 'network-error' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await hacsRes.text());
  } catch {
    return { ok: false, failure: 'malformed-hacs-json' };
  }
  if (!isMeaningfulHacsManifest(parsed)) {
    return { ok: false, failure: 'not-meaningful' };
  }

  return {
    ok: true,
    notes: repo.fork ? 'fork — submitter vouches as canonical' : undefined,
  };
}
