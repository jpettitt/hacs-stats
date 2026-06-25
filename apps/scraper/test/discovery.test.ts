import { describe, expect, it } from 'vitest';
import {
  discoverCustomRepos,
  inferKindFromManifest,
  isMeaningfulHacsManifest,
} from '../src/discovery.js';

describe('isMeaningfulHacsManifest', () => {
  it('accepts a manifest with any known HACS field', () => {
    expect(isMeaningfulHacsManifest({ name: 'x' })).toBe(true);
    expect(isMeaningfulHacsManifest({ filename: 'x.js' })).toBe(true);
    expect(isMeaningfulHacsManifest({ domain: 'foo' })).toBe(true);
    expect(isMeaningfulHacsManifest({ homeassistant: '2024.1' })).toBe(true);
    expect(isMeaningfulHacsManifest({ render_readme: true })).toBe(true);
  });

  it('rejects an object with only unrelated keys', () => {
    expect(isMeaningfulHacsManifest({ foo: 'bar' })).toBe(false);
    expect(isMeaningfulHacsManifest({ description: 'this is not a hacs key' })).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isMeaningfulHacsManifest(null)).toBe(false);
    expect(isMeaningfulHacsManifest(undefined)).toBe(false);
    expect(isMeaningfulHacsManifest([])).toBe(false);
    expect(isMeaningfulHacsManifest('string')).toBe(false);
    expect(isMeaningfulHacsManifest(42)).toBe(false);
  });
});

describe('discoverCustomRepos — filtering', () => {
  function searchHit(opts: { path: string; fullName: string; fork?: boolean }) {
    const [owner, name] = opts.fullName.split('/');
    return {
      name: opts.path.split('/').pop(),
      path: opts.path,
      repository: {
        full_name: opts.fullName,
        owner: { login: owner },
        name,
        html_url: `https://github.com/${opts.fullName}`,
        fork: opts.fork ?? false,
      },
    };
  }

  it('skips hits whose path is not exactly "hacs.json" (off-root)', async () => {
    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).startsWith('https://api.github.com/search/code')) {
        return new Response(
          JSON.stringify({
            total_count: 2,
            incomplete_results: false,
            items: [
              searchHit({ path: 'hacs.json', fullName: 'good/repo' }),
              searchHit({ path: 'templates/hacs.json', fullName: 'bad/subdir' }),
              searchHit({ path: 'subdir/hacs.json', fullName: 'also/bad' }),
            ],
          }),
        );
      }
      // raw.githubusercontent fetch for hacs.json — good/repo only.
      if (String(url).includes('good/repo/HEAD/hacs.json')) {
        return new Response(JSON.stringify({ name: 'Good', filename: 'good.js' }));
      }
      return new Response('not used', { status: 404 });
    };
    const result = await discoverCustomRepos({ token: 't', fetchImpl, maxPages: 1 });
    expect(result.candidates.map((c) => c.fullName)).toEqual(['good/repo']);
    expect(result.rejectedNonRoot).toBe(2);
  });

  it('skips forks even when path is "hacs.json"', async () => {
    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).startsWith('https://api.github.com/search/code')) {
        return new Response(
          JSON.stringify({
            total_count: 1,
            incomplete_results: false,
            items: [
              searchHit({ path: 'hacs.json', fullName: 'forky/repo', fork: true }),
              searchHit({ path: 'hacs.json', fullName: 'legit/repo' }),
            ],
          }),
        );
      }
      if (String(url).includes('legit/repo/HEAD/hacs.json')) {
        return new Response(JSON.stringify({ name: 'Legit', filename: 'l.js' }));
      }
      return new Response('not used', { status: 404 });
    };
    const result = await discoverCustomRepos({ token: 't', fetchImpl, maxPages: 1 });
    expect(result.candidates.map((c) => c.fullName)).toEqual(['legit/repo']);
    expect(result.rejectedFork).toBe(1);
  });

  it('skips hits whose hacs.json has no HACS-meaningful keys', async () => {
    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).startsWith('https://api.github.com/search/code')) {
        return new Response(
          JSON.stringify({
            total_count: 2,
            incomplete_results: false,
            items: [
              searchHit({ path: 'hacs.json', fullName: 'real/repo' }),
              searchHit({ path: 'hacs.json', fullName: 'fake/repo' }),
            ],
          }),
        );
      }
      if (String(url).includes('real/repo/HEAD/hacs.json')) {
        return new Response(JSON.stringify({ filename: 'good.js' }));
      }
      if (String(url).includes('fake/repo/HEAD/hacs.json')) {
        return new Response(JSON.stringify({ description: 'random json with this name' }));
      }
      return new Response('not used', { status: 404 });
    };
    const result = await discoverCustomRepos({ token: 't', fetchImpl, maxPages: 1 });
    expect(result.candidates.map((c) => c.fullName)).toEqual(['real/repo']);
    expect(result.rejectedNoMeaningfulFields).toBe(1);
  });

  it('skips repos already in the catalogue', async () => {
    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).startsWith('https://api.github.com/search/code')) {
        return new Response(
          JSON.stringify({
            total_count: 2,
            incomplete_results: false,
            items: [
              searchHit({ path: 'hacs.json', fullName: 'already/known' }),
              searchHit({ path: 'hacs.json', fullName: 'truly/new' }),
            ],
          }),
        );
      }
      if (String(url).includes('truly/new/HEAD/hacs.json')) {
        return new Response(JSON.stringify({ name: 'New', filename: 'new.js' }));
      }
      return new Response('not used', { status: 404 });
    };
    const result = await discoverCustomRepos({
      token: 't',
      fetchImpl,
      maxPages: 1,
      alreadyKnown: new Set(['already/known']),
    });
    expect(result.candidates.map((c) => c.fullName)).toEqual(['truly/new']);
    expect(result.alreadyKnown).toBe(1);
  });

  it('honours the query option (lets caller run size-band sweeps)', async () => {
    let observedUrl = '';
    const fetchImpl: typeof fetch = async (input) => {
      observedUrl = String(input);
      return new Response(JSON.stringify({ total_count: 0, incomplete_results: false, items: [] }));
    };
    await discoverCustomRepos({
      token: 't',
      fetchImpl,
      maxPages: 1,
      query: 'filename:hacs.json size:80..90',
    });
    expect(observedUrl).toContain('filename%3Ahacs.json%20size%3A80..90');
  });
});

describe('inferKindFromManifest', () => {
  it('detects plugins from .js filename', () => {
    expect(inferKindFromManifest({ filename: 'card.js' })).toBe('plugin');
  });

  it('detects themes from .yaml/.yml filename', () => {
    expect(inferKindFromManifest({ filename: 'pretty.yaml' })).toBe('theme');
    expect(inferKindFromManifest({ filename: 'pretty.yml' })).toBe('theme');
  });

  it('detects python scripts from .py filename', () => {
    expect(inferKindFromManifest({ filename: 'helper.py' })).toBe('python_script');
  });

  it('detects integrations from zip_release / domain', () => {
    expect(inferKindFromManifest({ zip_release: true })).toBe('integration');
    expect(inferKindFromManifest({ domain: 'thing' })).toBe('integration');
  });

  it('defaults to integration when no signal', () => {
    expect(inferKindFromManifest({ name: 'just a name' })).toBe('integration');
    expect(inferKindFromManifest(null)).toBe('integration');
  });
});

describe('discoverCustomRepos — autoApprove gate', () => {
  function searchHit(opts: { path: string; fullName: string; fork?: boolean }) {
    const [owner, name] = opts.fullName.split('/');
    return {
      name: opts.path.split('/').pop(),
      path: opts.path,
      repository: {
        full_name: opts.fullName,
        owner: { login: owner },
        name,
        html_url: `https://github.com/${opts.fullName}`,
        fork: opts.fork ?? false,
      },
    };
  }

  function mockGitHub(map: Record<string, () => Response>): typeof fetch {
    return (async (url: unknown) => {
      const key = String(url);
      for (const [prefix, fn] of Object.entries(map)) {
        if (key.includes(prefix)) return fn();
      }
      return new Response(`unexpected URL: ${key}`, { status: 500 });
    }) as typeof fetch;
  }

  it('flags repo as auto-approved when stars > threshold AND pushed_at within window', async () => {
    const fetchImpl = mockGitHub({
      '/search/code': () =>
        new Response(
          JSON.stringify({
            total_count: 1,
            incomplete_results: false,
            items: [searchHit({ path: 'hacs.json', fullName: 'popular/repo' })],
          }),
        ),
      'popular/repo/HEAD/hacs.json': () =>
        new Response(JSON.stringify({ name: 'Popular', filename: 'popular.js' })),
      '/repos/popular/repo': () =>
        new Response(
          JSON.stringify({ stargazers_count: 120, pushed_at: new Date().toISOString() }),
        ),
    });
    const r = await discoverCustomRepos({
      token: 't',
      fetchImpl,
      maxPages: 1,
      autoApprove: { minStars: 50, maxAgeMonths: 6 },
    });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]?.autoApprove).toBe(true);
    expect(r.candidates[0]?.kind).toBe('plugin');
    expect(r.autoApproved).toBe(1);
  });

  it('queues (does NOT auto-approve) when stars below threshold', async () => {
    const fetchImpl = mockGitHub({
      '/search/code': () =>
        new Response(
          JSON.stringify({
            total_count: 1,
            incomplete_results: false,
            items: [searchHit({ path: 'hacs.json', fullName: 'small/repo' })],
          }),
        ),
      'small/repo/HEAD/hacs.json': () =>
        new Response(JSON.stringify({ name: 'Small', filename: 'x.js' })),
      '/repos/small/repo': () =>
        new Response(JSON.stringify({ stargazers_count: 5, pushed_at: new Date().toISOString() })),
    });
    const r = await discoverCustomRepos({
      token: 't',
      fetchImpl,
      maxPages: 1,
      autoApprove: { minStars: 50, maxAgeMonths: 6 },
    });
    expect(r.candidates[0]?.autoApprove).toBe(false);
    expect(r.autoApproved).toBe(0);
  });

  it('queues (does NOT auto-approve) when stars > threshold but pushed_at too old', async () => {
    const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const fetchImpl = mockGitHub({
      '/search/code': () =>
        new Response(
          JSON.stringify({
            total_count: 1,
            incomplete_results: false,
            items: [searchHit({ path: 'hacs.json', fullName: 'stale/repo' })],
          }),
        ),
      'stale/repo/HEAD/hacs.json': () =>
        new Response(JSON.stringify({ name: 'Stale', filename: 'x.js' })),
      '/repos/stale/repo': () =>
        new Response(JSON.stringify({ stargazers_count: 500, pushed_at: oldDate })),
    });
    const r = await discoverCustomRepos({
      token: 't',
      fetchImpl,
      maxPages: 1,
      autoApprove: { minStars: 50, maxAgeMonths: 6 },
    });
    expect(r.candidates[0]?.autoApprove).toBe(false);
  });

  it('uses lowered knownOwnerMinStars when owner is in knownOwners set', async () => {
    const fetchImpl = mockGitHub({
      '/search/code': () =>
        new Response(
          JSON.stringify({
            total_count: 1,
            incomplete_results: false,
            items: [searchHit({ path: 'hacs.json', fullName: 'PiotrMachowski/new-thing' })],
          }),
        ),
      'PiotrMachowski/new-thing/HEAD/hacs.json': () =>
        new Response(JSON.stringify({ name: 'Thing', filename: 'thing.js' })),
      '/repos/PiotrMachowski/new-thing': () =>
        new Response(JSON.stringify({ stargazers_count: 8, pushed_at: new Date().toISOString() })),
    });
    // Owner only has 8 stars, well below the headline minStars=50 — but
    // because PiotrMachowski is in the trusted set, the 5-star floor
    // applies and the candidate is auto-approved.
    const r = await discoverCustomRepos({
      token: 't',
      fetchImpl,
      maxPages: 1,
      autoApprove: {
        minStars: 50,
        maxAgeMonths: 6,
        knownOwnerMinStars: 5,
        knownOwners: new Set(['piotrmachowski']),
      },
    });
    expect(r.candidates[0]?.autoApprove).toBe(true);
    expect(r.autoApproved).toBe(1);
  });

  it('still applies the headline minStars when owner is NOT in knownOwners', async () => {
    const fetchImpl = mockGitHub({
      '/search/code': () =>
        new Response(
          JSON.stringify({
            total_count: 1,
            incomplete_results: false,
            items: [searchHit({ path: 'hacs.json', fullName: 'rando/repo' })],
          }),
        ),
      'rando/repo/HEAD/hacs.json': () =>
        new Response(JSON.stringify({ name: 'R', filename: 'r.js' })),
      '/repos/rando/repo': () =>
        new Response(JSON.stringify({ stargazers_count: 8, pushed_at: new Date().toISOString() })),
    });
    const r = await discoverCustomRepos({
      token: 't',
      fetchImpl,
      maxPages: 1,
      autoApprove: {
        minStars: 50,
        maxAgeMonths: 6,
        knownOwnerMinStars: 5,
        knownOwners: new Set(['piotrmachowski']),
      },
    });
    expect(r.candidates[0]?.autoApprove).toBe(false);
  });

  it('omits autoApprove gate entirely when option not supplied', async () => {
    const fetchImpl = mockGitHub({
      '/search/code': () =>
        new Response(
          JSON.stringify({
            total_count: 1,
            incomplete_results: false,
            items: [searchHit({ path: 'hacs.json', fullName: 'a/b' })],
          }),
        ),
      'a/b/HEAD/hacs.json': () => new Response(JSON.stringify({ name: 'A', filename: 'a.js' })),
    });
    const r = await discoverCustomRepos({ token: 't', fetchImpl, maxPages: 1 });
    expect(r.candidates[0]?.autoApprove).toBe(false);
    expect(r.candidates[0]?.stars).toBeUndefined();
  });
});
