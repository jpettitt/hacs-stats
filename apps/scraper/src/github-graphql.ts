import type { RateLimitGuard } from './rate-limit.js';

const ENDPOINT = 'https://api.github.com/graphql';
const USER_AGENT = 'hacs-stats/0.0.0 (+https://hacs-stats.dev)';

/** Default sleep when GitHub returns a secondary rate-limit response with
 * no Retry-After header. Secondary limits typically clear in 60s. */
const SECONDARY_RETRY_DEFAULT_SLEEP_MS = 60_000;
const SECONDARY_RETRY_MAX_ATTEMPTS = 4;

/**
 * GitHub's secondary rate limits (distinct from the per-hour quota) hit
 * for burst-y traffic and return HTTP 403 or 429 with a message body
 * mentioning "secondary rate limit". The right response per their docs
 * is to honour Retry-After and try again. Without this wrapper one
 * secondary trip kills the whole scrape, which is exactly the failure
 * mode that landed us here on the first VPS scrape.
 */
async function postWithSecondaryLimitRetry(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
): Promise<Response> {
  for (let attempt = 1; attempt <= SECONDARY_RETRY_MAX_ATTEMPTS; attempt++) {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
    if (res.status !== 403 && res.status !== 429) return res;
    // Peek at the body without consuming the original response — clone
    // first so the caller still gets a readable stream if this turns out
    // not to be a secondary-limit response.
    const peek = await res.clone().text();
    if (!/secondary rate limit/i.test(peek)) return res;
    if (attempt === SECONDARY_RETRY_MAX_ATTEMPTS) return res;
    const retryAfterHeader = res.headers.get('retry-after');
    const retryAfterMs = retryAfterHeader
      ? Math.max(1, Number(retryAfterHeader)) * 1000
      : SECONDARY_RETRY_DEFAULT_SLEEP_MS;
    console.warn(
      `[graphql] secondary rate limit (attempt ${attempt}/${SECONDARY_RETRY_MAX_ATTEMPTS}) — sleeping ${retryAfterMs}ms`,
    );
    await new Promise((r) => setTimeout(r, retryAfterMs));
  }
  // Unreachable — the loop above always returns or sleeps + continues.
  throw new Error('postWithSecondaryLimitRetry: exhausted retries');
}

/**
 * A 5xx, a dropped connection, or a cut-off body. GitHub's GraphQL front
 * end returns 502/504 when a query times out, so a retry or a smaller
 * batch usually succeeds. About half of the nightly scrapes in Oct 2026
 * died on one of these before they were retried.
 */
export class TransientGraphqlError extends Error {
  override name = 'TransientGraphqlError';
}

const TRANSIENT_RETRY_DELAYS_MS = [2_000, 8_000];

/** When this many single repos still fail, GitHub is down rather than
 * timing out on some queries — abort instead of splitting every remaining
 * batch down to single repos. (Not a consecutive-failure count: splitting
 * down to one bad repo alone fails ~8 requests in a row.) */
const MAX_SKIPPED_REPOS = 10;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function postOnce(fetchImpl: typeof fetch, token: string, query: string): Promise<unknown> {
  let res: Response;
  let text: string;
  try {
    res = await postWithSecondaryLimitRetry(fetchImpl, token, query);
    if (res.status >= 500) {
      await res.body?.cancel();
      throw new TransientGraphqlError(`graphql ${res.status}`);
    }
    text = await res.text();
  } catch (err) {
    // fetch surfaces connection resets (also mid-body) as TypeError.
    if (err instanceof TypeError)
      throw new TransientGraphqlError(`graphql network: ${err.message}`);
    throw err;
  }
  if (!res.ok) throw new Error(`graphql ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new TransientGraphqlError(`graphql: cut-off JSON body (${text.length} bytes)`);
  }
}

async function postWithTransientRetry(opts: FetchOptions, query: string): Promise<unknown> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await postOnce(opts.fetchImpl ?? fetch, opts.token, query);
    } catch (err) {
      const delay = TRANSIENT_RETRY_DELAYS_MS[attempt];
      if (!(err instanceof TransientGraphqlError) || delay === undefined) throw err;
      console.warn(
        `[graphql] ${err.message} (retry ${attempt + 1}/${TRANSIENT_RETRY_DELAYS_MS.length} in ${delay}ms)`,
      );
      await sleep(delay);
    }
  }
}
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
  /** What we ASKED for ("owner/name" of the row being scraped). */
  fullName: string;
  /** What GitHub canonically calls the repo. Differs from `fullName` when
   * the repo has been moved/renamed and GitHub redirected — the caller uses
   * this to detect duplicates and rename in place. Null when the lookup
   * failed entirely (repo missing). */
  canonicalFullName: string | null;
  /** null when the repo is missing (renamed, deleted, made private). */
  stars: number | null;
  forks: number | null;
  openIssues: number | null;
  lastCommitAt: string | null;
  description: string | null;
  archived: boolean | null;
  isFork: boolean | null;
  /** Parent repo "owner/name" for forks; null for non-forks (or when GitHub omits it). */
  parentFullName: string | null;
  defaultBranch: string | null;
}

export interface FetchOptions {
  token: string;
  /** Inject for tests. */
  fetchImpl?: typeof fetch;
  guard?: RateLimitGuard;
  /** Override default 100. */
  batchSize?: number;
  /** Inject for tests (transient-retry backoff). */
  sleep?: (ms: number) => Promise<void>;
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
      isFork
      parent { nameWithOwner }
    }
  `;

  const payload = (await postWithTransientRetry(opts, query)) as {
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
          nameWithOwner: string;
          stargazerCount: number;
          forkCount: number;
          issues: { totalCount: number };
          defaultBranchRef: {
            name: string;
            target?: { committedDate?: string };
          } | null;
          description: string | null;
          isArchived: boolean;
          isFork: boolean;
          parent: { nameWithOwner: string } | null;
        }
      | null
      | undefined;
    const fullName = `${id.owner}/${id.name}`;
    if (!node) {
      return {
        fullName,
        canonicalFullName: null,
        stars: null,
        forks: null,
        openIssues: null,
        lastCommitAt: null,
        description: null,
        archived: null,
        isFork: null,
        parentFullName: null,
        defaultBranch: null,
      };
    }
    return {
      fullName,
      // GraphQL returns the CANONICAL nameWithOwner — if the requested
      // owner/name was redirected, this differs from `fullName`.
      canonicalFullName: typeof node.nameWithOwner === 'string' ? node.nameWithOwner : null,
      stars: node.stargazerCount,
      forks: node.forkCount,
      openIssues: node.issues.totalCount,
      lastCommitAt: node.defaultBranchRef?.target?.committedDate ?? null,
      description: node.description,
      archived: node.isArchived,
      isFork: node.isFork,
      parentFullName: node.parent?.nameWithOwner ?? null,
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
  // Inter-batch throttle. Empirically, firing 39 back-to-back GraphQL
  // batches at ~2-5/sec from a single IP trips GitHub's secondary rate
  // limit ~4 times per scrape; each trip costs 60s. Sleeping ~750ms
  // between batches paces us to ~1.3 batches/sec — well under the
  // secondary threshold — and finishes the whole step faster than
  // hitting + recovering. Override via GRAPHQL_BATCH_DELAY_MS to tune.
  const interBatchSleepMs = Number(process.env.GRAPHQL_BATCH_DELAY_MS ?? 750);
  let first = true;
  const failures = { skipped: 0 };
  for (let i = 0; i < identifiers.length; i += size) {
    if (opts.guard) await opts.guard.waitIfNeeded();
    if (!first && interBatchSleepMs > 0) {
      await new Promise((r) => setTimeout(r, interBatchSleepMs));
    }
    first = false;
    const slice = identifiers.slice(i, i + size);
    yield await fetchWithSplit(slice, opts, failures);
  }
}

/**
 * On a transient failure that outlasts the retries, split the slice in
 * half: a smaller query is less likely to time out. A single repo that
 * still fails is left out of the result, not returned as missing — the
 * caller would count a missing repo against its lifecycle (offline →
 * removed). It gets a fresh try on the next scrape.
 */
async function fetchWithSplit(
  slice: readonly { owner: string; name: string }[],
  opts: FetchOptions,
  failures: { skipped: number },
): Promise<RepoMetadata[]> {
  try {
    return await fetchOneBatch(slice, opts);
  } catch (err) {
    if (!(err instanceof TransientGraphqlError)) throw err;
    if (slice.length === 1) {
      if (++failures.skipped >= MAX_SKIPPED_REPOS) throw err;
      console.warn(`[graphql] skipping ${slice[0]?.owner}/${slice[0]?.name}: ${err.message}`);
      return [];
    }
    const mid = Math.ceil(slice.length / 2);
    console.warn(`[graphql] ${err.message} on ${slice.length} repos — splitting the batch`);
    const left = await fetchWithSplit(slice.slice(0, mid), opts, failures);
    const right = await fetchWithSplit(slice.slice(mid), opts, failures);
    return [...left, ...right];
  }
}

// Re-exported for tests to call directly without the generator wrapper.
export { fetchOneBatch as _fetchOneBatchForTests };
