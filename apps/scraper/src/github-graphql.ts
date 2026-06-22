import type { RateLimitGuard } from './rate-limit.js';

const ENDPOINT = 'https://api.github.com/graphql';
const USER_AGENT = 'hacs-stats/0.0.0 (+https://hacs-stats.dev)';
/**
 * Batch size: 100 repos per query.
 *
 * GitHub's published GraphQL node limit is 500K nodes per query, but in
 * practice a 100-repo query stays well under all the soft limits (cost,
 * timeout, response size) and yields ~34 queries for the full 3.3k catalog —
 * a trivial fraction of the 5000-point/hour budget.
 */
export const DEFAULT_BATCH_SIZE = 100;

export interface RepoMetadata {
  fullName: string;
  /** null when the repo is missing (renamed, deleted, made private). */
  stars: number | null;
  forks: number | null;
  openIssues: number | null;
  lastCommitAt: string | null;
  description: string | null;
  archived: boolean | null;
  defaultBranch: string | null;
}

export interface FetchOptions {
  token: string;
  /** Inject for tests. */
  fetchImpl?: typeof fetch;
  guard?: RateLimitGuard;
  /** Override default 100. */
  batchSize?: number;
}

/**
 * Fetch metadata for one batch of repos. Skips the rate-limit guard's
 * wait-if-needed step — the orchestrator should call `guard.waitIfNeeded()`
 * itself between batches so the wait is sequential, not racing N workers.
 *
 * Returns one entry per requested repo, in the same order. Missing repos
 * carry null fields and the fullName from the request.
 */
async function fetchOneBatch(
  identifiers: readonly { owner: string; name: string }[],
  opts: FetchOptions,
): Promise<RepoMetadata[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const aliasFor = (i: number) => `r${i}`;
  // Build one repository(...) call per alias. Variables would let us reuse
  // a single query string across batches, but inlining is fine: a 100-repo
  // batch is ~10KB, well under any sane query-size limit.
  const reposBlock = identifiers
    .map(
      (id, i) =>
        `${aliasFor(i)}: repository(owner: ${JSON.stringify(id.owner)}, name: ${JSON.stringify(id.name)}) { ...RepoFields }`,
    )
    .join('\n');
  const query = `
    query {
      rateLimit { remaining resetAt cost }
      ${reposBlock}
    }
    fragment RepoFields on Repository {
      nameWithOwner
      stargazerCount
      forkCount
      issues(states: OPEN) { totalCount }
      defaultBranchRef { name target { ... on Commit { committedDate } } }
      description
      isArchived
    }
  `;

  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`graphql ${res.status}: ${body.slice(0, 300)}`);
  }

  const payload = (await res.json()) as {
    data?: Record<string, unknown> & { rateLimit?: { remaining: number; resetAt: string } };
    errors?: { message: string; type?: string }[];
  };

  // GraphQL's "partial success" model: missing/renamed repos show up as NOT_FOUND
  // errors AND as null aliases in data. We tolerate them — they're expected —
  // and only throw on errors that aren't per-alias NOT_FOUND.
  const errs = payload.errors ?? [];
  const fatal = errs.filter((e) => e.type !== 'NOT_FOUND');
  if (fatal.length) {
    throw new Error(`graphql errors: ${fatal.map((e) => e.message).join('; ')}`);
  }

  // Update the guard from the rateLimit field.
  if (opts.guard && payload.data?.rateLimit) {
    const rl = payload.data.rateLimit;
    opts.guard.observe({
      remaining: rl.remaining,
      resetAtMs: new Date(rl.resetAt).getTime(),
    });
  }

  const data = payload.data ?? {};
  return identifiers.map((id, i) => {
    const node = data[aliasFor(i)] as
      | {
          stargazerCount: number;
          forkCount: number;
          issues: { totalCount: number };
          defaultBranchRef: {
            name: string;
            target?: { committedDate?: string };
          } | null;
          description: string | null;
          isArchived: boolean;
        }
      | null
      | undefined;
    const fullName = `${id.owner}/${id.name}`;
    if (!node) {
      return {
        fullName,
        stars: null,
        forks: null,
        openIssues: null,
        lastCommitAt: null,
        description: null,
        archived: null,
        defaultBranch: null,
      };
    }
    return {
      fullName,
      stars: node.stargazerCount,
      forks: node.forkCount,
      openIssues: node.issues.totalCount,
      lastCommitAt: node.defaultBranchRef?.target?.committedDate ?? null,
      description: node.description,
      archived: node.isArchived,
      defaultBranch: node.defaultBranchRef?.name ?? null,
    };
  });
}

/**
 * Fetch metadata for arbitrary many repos, batching into queries of `batchSize`
 * (default 100). Yields one array of results per batch in input order. Pause
 * + retry on rate-limit pressure is the orchestrator's job (call
 * `guard.waitIfNeeded()` between batches).
 */
export async function* fetchRepoMetadataBatches(
  identifiers: readonly { owner: string; name: string }[],
  opts: FetchOptions,
): AsyncGenerator<RepoMetadata[]> {
  const size = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  for (let i = 0; i < identifiers.length; i += size) {
    if (opts.guard) await opts.guard.waitIfNeeded();
    const slice = identifiers.slice(i, i + size);
    yield await fetchOneBatch(slice, opts);
  }
}

// Re-exported for tests to call directly without the generator wrapper.
export { fetchOneBatch as _fetchOneBatchForTests };
