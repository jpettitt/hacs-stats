import { describe, expect, it } from 'vitest';
import {
  type RepoMetadata,
  TransientGraphqlError,
  _fetchOneBatchForTests as fetchOneBatch,
  fetchRepoMetadataBatches,
} from '../src/github-graphql.js';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('fetchOneBatch', () => {
  it('maps GraphQL response to RepoMetadata in input order', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonRes({
        data: {
          rateLimit: { remaining: 4999, resetAt: '2026-06-21T00:00:00Z', cost: 1 },
          r0: {
            nameWithOwner: 'a/b',
            stargazerCount: 10,
            forkCount: 2,
            issues: { totalCount: 3 },
            defaultBranchRef: {
              name: 'main',
              target: { committedDate: '2026-06-20T12:00:00Z' },
            },
            description: 'desc',
            isArchived: false,
            isFork: false,
            parent: null,
          },
          r1: {
            nameWithOwner: 'c/d',
            stargazerCount: 0,
            forkCount: 0,
            issues: { totalCount: 0 },
            defaultBranchRef: null,
            description: null,
            isArchived: true,
            isFork: false,
            parent: null,
          },
        },
      });
    const res = await fetchOneBatch(
      [
        { owner: 'a', name: 'b' },
        { owner: 'c', name: 'd' },
      ],
      { token: 'x', fetchImpl },
    );
    expect(res).toEqual([
      {
        fullName: 'a/b',
        canonicalFullName: 'a/b',
        stars: 10,
        forks: 2,
        openIssues: 3,
        lastCommitAt: '2026-06-20T12:00:00Z',
        description: 'desc',
        archived: false,
        isFork: false,
        parentFullName: null,
        defaultBranch: 'main',
      },
      {
        fullName: 'c/d',
        canonicalFullName: 'c/d',
        stars: 0,
        forks: 0,
        openIssues: 0,
        lastCommitAt: null,
        description: null,
        archived: true,
        isFork: false,
        parentFullName: null,
        defaultBranch: null,
      },
    ]);
  });

  it('detects a redirect: when nameWithOwner differs from the request, canonical is the new name', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            r0: {
              nameWithOwner: 'NewOwner/new-name', // <-- moved on GitHub
              stargazerCount: 5,
              forkCount: 0,
              issues: { totalCount: 0 },
              defaultBranchRef: null,
              description: null,
              isArchived: false,
              isFork: false,
              parent: null,
            },
          },
        }),
      );
    const res = await fetchOneBatch([{ owner: 'OldOwner', name: 'old-name' }], {
      token: 'x',
      fetchImpl,
    });
    expect(res[0]?.fullName).toBe('OldOwner/old-name');
    expect(res[0]?.canonicalFullName).toBe('NewOwner/new-name');
  });

  it('tolerates NOT_FOUND aliases — they come back with null fields', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonRes({
        data: { r0: null, r1: null },
        errors: [
          { type: 'NOT_FOUND', message: 'Could not resolve to a Repository with the name a/b.' },
          { type: 'NOT_FOUND', message: 'Could not resolve to a Repository with the name c/d.' },
        ],
      });
    const res = await fetchOneBatch(
      [
        { owner: 'a', name: 'b' },
        { owner: 'c', name: 'd' },
      ],
      { token: 'x', fetchImpl },
    );
    expect(res.every((r) => r.stars === null)).toBe(true);
    expect(res.map((r) => r.fullName)).toEqual(['a/b', 'c/d']);
  });

  it('throws on non-NOT_FOUND errors', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonRes({ errors: [{ message: 'Bad credentials', type: 'FORBIDDEN' }] });
    await expect(
      fetchOneBatch([{ owner: 'a', name: 'b' }], { token: 'x', fetchImpl }),
    ).rejects.toThrow(/Bad credentials/);
  });

  it('sends auth header + query body', async () => {
    let seenAuth = '';
    let seenQuery = '';
    const fetchImpl: typeof fetch = async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      seenAuth = headers.Authorization;
      const body = JSON.parse(String(init?.body)) as { query: string };
      seenQuery = body.query;
      return jsonRes({ data: { r0: null } });
    };
    await fetchOneBatch([{ owner: 'a', name: 'b' }], { token: 'tok123', fetchImpl });
    expect(seenAuth).toBe('Bearer tok123');
    expect(seenQuery).toContain('repository(owner: "a", name: "b")');
    expect(seenQuery).toContain('stargazerCount');
  });
});

const noSleep = async () => {};

/** Fake GraphQL server: answers each `rN: repository(owner: "o", name: "n")`
 * alias in the query, or returns `fail(repos)` when that is set and truthy
 * for the repos in this request. */
function fakeServer(fail?: (repos: string[]) => Response | undefined) {
  const requests: string[][] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    const repos = [...query.matchAll(/repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)].map(
      (m) => `${m[1]}/${m[2]}`,
    );
    requests.push(repos);
    const failure = fail?.(repos);
    if (failure) return failure;
    const data = Object.fromEntries(
      repos.map((nameWithOwner, i) => [
        `r${i}`,
        {
          nameWithOwner,
          stargazerCount: 1,
          forkCount: 0,
          issues: { totalCount: 0 },
          defaultBranchRef: null,
          description: null,
          isArchived: false,
          isFork: false,
          parent: null,
        },
      ]),
    );
    return jsonRes({ data });
  };
  return { fetchImpl, requests };
}

const badGateway = () => new Response('<html><h1>502 Bad Gateway</h1></html>', { status: 502 });

const idents = (n: number) => Array.from({ length: n }, (_, i) => ({ owner: 'o', name: `r${i}` }));

async function collect(gen: AsyncGenerator<RepoMetadata[]>): Promise<RepoMetadata[][]> {
  const out: RepoMetadata[][] = [];
  for await (const batch of gen) out.push(batch);
  return out;
}

describe('fetchOneBatch transient failures', () => {
  it('retries a 502 and returns the data', async () => {
    let calls = 0;
    const { fetchImpl } = fakeServer(() => (calls++ === 0 ? badGateway() : undefined));
    const res = await fetchOneBatch([{ owner: 'a', name: 'b' }], {
      token: 'x',
      fetchImpl,
      sleep: noSleep,
    });
    expect(res[0]?.stars).toBe(1);
    expect(calls).toBe(2);
  });

  it('retries a 200 with a cut-off JSON body', async () => {
    let calls = 0;
    const { fetchImpl } = fakeServer(() =>
      calls++ === 0 ? new Response('{"data":{"r0":{"nameWith', { status: 200 }) : undefined,
    );
    const res = await fetchOneBatch([{ owner: 'a', name: 'b' }], {
      token: 'x',
      fetchImpl,
      sleep: noSleep,
    });
    expect(res[0]?.stars).toBe(1);
  });

  it('does not retry a 401', async () => {
    const { fetchImpl, requests } = fakeServer(
      () => new Response('{"message":"Bad credentials"}', { status: 401 }),
    );
    await expect(
      fetchOneBatch([{ owner: 'a', name: 'b' }], { token: 'x', fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/graphql 401/);
    expect(requests).toHaveLength(1);
  });
});

describe('fetchRepoMetadataBatches transient failures', () => {
  it('splits a batch that keeps timing out and returns every repo in order', async () => {
    // GitHub times out on big queries: anything over 3 repos always 502s.
    const { fetchImpl } = fakeServer((repos) => (repos.length > 3 ? badGateway() : undefined));
    const batches = await collect(
      fetchRepoMetadataBatches(idents(10), {
        token: 'x',
        fetchImpl,
        sleep: noSleep,
        batchSize: 10,
      }),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((m) => m.fullName)).toEqual(idents(10).map((i) => `o/${i.name}`));
  });

  it('leaves out a repo that still fails alone, instead of reporting it missing', async () => {
    const { fetchImpl } = fakeServer((repos) =>
      repos.includes('o/r4') ? badGateway() : undefined,
    );
    const [batch] = await collect(
      fetchRepoMetadataBatches(idents(10), {
        token: 'x',
        fetchImpl,
        sleep: noSleep,
        batchSize: 10,
      }),
    );
    expect(batch?.map((m) => m.fullName)).toEqual(
      idents(10)
        .map((i) => `o/${i.name}`)
        .filter((n) => n !== 'o/r4'),
    );
    expect(batch?.every((m) => m.stars !== null)).toBe(true);
  });

  it('aborts when GitHub fails everything, instead of splitting forever', async () => {
    const { fetchImpl, requests } = fakeServer(() => badGateway());
    await expect(
      collect(
        fetchRepoMetadataBatches(idents(100), {
          token: 'x',
          fetchImpl,
          sleep: noSleep,
          batchSize: 100,
        }),
      ),
    ).rejects.toThrow(TransientGraphqlError);
    // 10 skipped leaves, not ~199 split requests x 3 tries.
    expect(requests.length).toBeLessThan(100);
  });
});
