import { describe, expect, it } from 'vitest';
import { discoverCustomRepos, isMeaningfulHacsManifest } from '../src/discovery.js';

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
});
