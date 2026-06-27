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

/**
 * Hard-coded deny-list for platform / meta repos. These ARE valid HACS-
 * manifest-bearing repos but they're not "HACS modules" in the
 * user-installable sense — hacs/integration is HACS itself. They're also
 * marked suppressed=1 in the `repos` table (see migration 0010) so any
 * existing row is hidden from listings; this set prevents re-discovery
 * from re-adding them next sweep. Match is on lowercased full_name so
 * casing differences don't slip through.
 */
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

export interface CandidateRepo {
  fullName: string;
  owner: string;
  name: string;
  htmlUrl: string;
  /** Inferred from hacs.json shape — integration / plugin / theme / etc.
   * Used to seed the repos row when auto-approving so we don't have to
   * guess at accept time. */
  kind:
    | 'integration'
    | 'plugin'
    | 'theme'
    | 'appdaemon'
    | 'netdaemon'
    | 'python_script'
    | 'template';
  /** Stars at the time we discovered the repo. Populated whenever the
   * details fetch succeeded (which is unconditional now — see
   * `fetchRepoDetails` call site). Only undefined when the REST lookup
   * failed (404 / rate-limit). */
  stars?: number;
  /** Latest GitHub push timestamp (ISO). Same caveat as stars. */
  pushedAt?: string;
  /** GitHub repo description. Same caveat as stars. */
  description?: string | null;
  /** True when the repo cleared the autoApprove thresholds. Caller writes
   * these directly into `repos` instead of `discovery_queue`. */
  autoApprove: boolean;
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

export interface AutoApproveCriteria {
  minStars: number;
  maxAgeMonths: number;
  /** Lower stars threshold to apply when the candidate's owner already has
   * at least one repo in the supplied `knownOwners` set. Rationale: an
   * owner who has already shipped a repo HACS users trust is a stronger
   * signal than raw star count alone — a new card from PiotrMachowski
   * with 8 stars is more interesting than an unknown owner with 8 stars.
   * Ignored when knownOwners is empty. */
  knownOwnerMinStars?: number;
  /** Set of GitHub owners (lowercase login) treated as "trusted" for the
   * knownOwnerMinStars threshold. Typically the set of owners with at
   * least one source='default' (main HACS list) repo. */
  knownOwners?: Set<string>;
}

export interface DiscoveryOptions {
  token: string;
  /** Maximum pages of code-search results to walk. GitHub caps at ~1000 results = 10 pages of 100. */
  maxPages?: number;
  /** Override the search query — defaults to `filename:hacs.json`. Lets
   * the caller run different size-band sweeps to break past the 1000-cap
   * (`filename:hacs.json size:<60`, `size:60..80`, …). */
  query?: string;
  /** When set, candidates clearing minStars + maxAgeMonths (since `pushed_at`)
   * are flagged `autoApprove=true`. Requires one extra REST call per
   * candidate to read stars/pushed_at — only fired for candidates that
   * passed the other validation steps. */
  autoApprove?: AutoApproveCriteria;
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
  /** Candidates whose GitHub pushed_at was older than 3 years — no point
   * queueing repos that are clearly abandoned. */
  rejectedStale: number;
  /** Candidates with 0 stars. The skip-set excludes auto-rejected rows,
   * so if the repo later picks up stars the next sweep will re-find it
   * — this just keeps the queue manageable in the meantime. */
  rejectedZeroStars: number;
  alreadyKnown: number;
  /** How many of `candidates` cleared the autoApprove thresholds. */
  autoApproved: number;
}

/** Discovery uses a stricter 1-year staleness bar than the listing
 * filter (3y). Rationale: discovery is unattended — code-search hits
 * have no human vouching for them, so we want a higher freshness bar
 * before adding more work to the admin queue. Users CAN still surface
 * a 1–3y repo via the public /submit form (where they're personally
 * vouching for it); the listing-time 3y rule then hides it anyway if it
 * goes past three. */
const STALE_MS = 365 * 24 * 60 * 60 * 1000;

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

type RepoKindGuess = CandidateRepo['kind'];

/**
 * Best-effort kind inference from hacs.json shape. HACS itself decides kind
 * by which file the repo appears in (default/integration vs default/plugin
 * etc.) — for discovered repos we don't have that signal, so we guess from
 * the manifest fields. Conservative defaults: when in doubt, integration
 * (the most common HACS category).
 */
export function inferKindFromManifest(parsed: unknown): RepoKindGuess {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'integration';
  const m = parsed as Record<string, unknown>;
  const filename = typeof m.filename === 'string' ? m.filename : '';
  if (filename.endsWith('.js')) return 'plugin';
  if (filename.endsWith('.yaml') || filename.endsWith('.yml')) return 'theme';
  if (filename.endsWith('.py')) return 'python_script';
  if (m.zip_release === true || typeof m.domain === 'string') return 'integration';
  return 'integration';
}

interface RepoDetails {
  stars: number;
  pushedAt: string;
  description: string | null;
}

/**
 * Lookup stars + pushed_at + description via the REST repo endpoint. One
 * extra request per candidate, but only fired for candidates that already
 * cleared the cheap validation (root-only / non-fork / has-hacs.json) —
 * bounded by the surviving-candidate count, not the total search hits.
 * Description is included so the admin queue can show it without a
 * per-page-render fetch.
 */
async function fetchRepoDetails(
  fullName: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<RepoDetails | null> {
  const res = await fetchImpl(`https://api.github.com/repos/${fullName}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    stargazers_count?: number;
    pushed_at?: string;
    description?: string | null;
  };
  if (typeof body.stargazers_count !== 'number' || typeof body.pushed_at !== 'string') return null;
  return {
    stars: body.stargazers_count,
    pushedAt: body.pushed_at,
    description: typeof body.description === 'string' ? body.description : null,
  };
}

function passesAutoApprove(
  details: RepoDetails,
  criteria: AutoApproveCriteria,
  owner: string,
  now: number,
): boolean {
  // Trusted-owner discount: if this owner already has a repo in the
  // catalogue (passed as knownOwners), drop to the lower stars bar.
  const ownerIsKnown = criteria.knownOwners?.has(owner.toLowerCase()) ?? false;
  const effectiveMinStars =
    ownerIsKnown && typeof criteria.knownOwnerMinStars === 'number'
      ? criteria.knownOwnerMinStars
      : criteria.minStars;
  if (details.stars < effectiveMinStars) return false;
  const pushedMs = Date.parse(details.pushedAt);
  if (!Number.isFinite(pushedMs)) return false;
  const cutoffMs = now - criteria.maxAgeMonths * 30 * 24 * 60 * 60 * 1000;
  return pushedMs >= cutoffMs;
}

export async function discoverCustomRepos(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxPages = opts.maxPages ?? 10;
  const query = opts.query ?? 'filename:hacs.json';
  const now = Date.now();
  const seen = new Set<string>(); // dedupe within this run; one repo may hit on multiple branches/forks
  const alreadyKnown = opts.alreadyKnown ?? new Set();

  const result: DiscoveryResult = {
    candidates: [],
    inspected: 0,
    rejectedNonRoot: 0,
    rejectedFork: 0,
    rejectedNoMeaningfulFields: 0,
    rejectedNoManifest: 0,
    rejectedStale: 0,
    rejectedZeroStars: 0,
    alreadyKnown: 0,
    autoApproved: 0,
  };

  for (let page = 1; page <= maxPages; page++) {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&per_page=100&page=${page}`;
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
      if (SUPPRESSED_FULLNAMES.has(fullName.toLowerCase())) {
        // Treat as already-known so the summary counter is honest about
        // what we filtered out (vs lumping into a different reject bucket).
        result.alreadyKnown++;
        continue;
      }
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

      const kind = inferKindFromManifest(manifest);

      // 4. Repo details lookup — one extra REST call per surviving candidate
      //    to read stars + pushed_at + description. ALWAYS fired now (was
      //    autoApprove-only) so the admin queue UI can show + sort by stars
      //    and freshness without a per-page-render fetch. Costs are bounded
      //    by surviving candidates, not total search hits.
      let autoApprove = false;
      let stars: number | undefined;
      let pushedAt: string | undefined;
      let description: string | null | undefined;
      const details = await fetchRepoDetails(fullName, opts.token, fetchImpl);
      if (details) {
        // Hard reject anything older than 3 years — no point queueing a
        // repo we'd hide from every listing the moment it was accepted.
        const pushedMs = Date.parse(details.pushedAt);
        if (Number.isFinite(pushedMs) && now - pushedMs > STALE_MS) {
          result.rejectedStale++;
          continue;
        }
        // Hard reject 0-star repos. If the repo later picks up stars
        // the next sweep will re-find it (auto-rejected rows are
        // excluded from the discover skip-set) — this just keeps the
        // queue manageable in the meantime.
        if (details.stars === 0) {
          result.rejectedZeroStars++;
          continue;
        }
        stars = details.stars;
        pushedAt = details.pushedAt;
        description = details.description;
        if (opts.autoApprove) {
          autoApprove = passesAutoApprove(
            details,
            opts.autoApprove,
            item.repository.owner.login,
            now,
          );
          if (autoApprove) result.autoApproved++;
        }
      }

      result.candidates.push({
        fullName,
        owner: item.repository.owner.login,
        name: item.repository.name,
        htmlUrl: item.repository.html_url,
        kind,
        ...(stars !== undefined ? { stars } : {}),
        ...(pushedAt !== undefined ? { pushedAt } : {}),
        ...(description !== undefined ? { description } : {}),
        autoApprove,
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
