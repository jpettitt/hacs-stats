import { describe, expect, it } from 'vitest';
import { _fetchOneBatchForTests as fetchOneBatch } from '../src/github-graphql.js';

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
