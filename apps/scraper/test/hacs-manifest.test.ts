import { describe, expect, it } from 'vitest';
import { fetchHacsManifest, manifestFilename, manifestName } from '../src/hacs-manifest.js';

function res(body: string, status: number): Response {
  return new Response(body, { status });
}

describe('fetchHacsManifest', () => {
  it('parses a plugin manifest with filename', async () => {
    const fetchImpl = async () =>
      res(JSON.stringify({ name: 'Weather Radar', filename: 'weather-radar-card.js' }), 200);
    const m = await fetchHacsManifest('jpettitt/weather-radar-card', { fetchImpl });
    expect(m?.filename).toBe('weather-radar-card.js');
    expect(manifestFilename(m)).toBe('weather-radar-card.js');
  });

  it('returns null on 404 (no manifest, common for legacy repos)', async () => {
    const fetchImpl = async () => res('404: Not Found', 404);
    const m = await fetchHacsManifest('does/not-exist', { fetchImpl });
    expect(m).toBeNull();
    expect(manifestFilename(m)).toBeNull();
  });

  it('returns null on any other 4xx (renamed / archived / private)', async () => {
    const fetchImpl = async () => res('forbidden', 403);
    const m = await fetchHacsManifest('private/repo', { fetchImpl });
    expect(m).toBeNull();
  });

  it('returns null on malformed JSON instead of throwing', async () => {
    const fetchImpl = async () => res('not json at all', 200);
    const m = await fetchHacsManifest('broken/repo', { fetchImpl });
    expect(m).toBeNull();
  });

  it('returns null on JSON that is not an object', async () => {
    const fetchImpl = async () => res(JSON.stringify(['array', 'not', 'object']), 200);
    const m = await fetchHacsManifest('weird/repo', { fetchImpl });
    expect(m).toBeNull();
  });

  it('retries on 5xx then surfaces success', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      if (calls === 1) return res('upstream down', 503);
      return res(JSON.stringify({ filename: 'card.js' }), 200);
    };
    const m = await fetchHacsManifest('flaky/repo', {
      fetchImpl,
      sleep: async () => {},
    });
    expect(m?.filename).toBe('card.js');
    expect(calls).toBe(2);
  });
});

describe('manifestFilename', () => {
  it('returns null for missing or empty filename', () => {
    expect(manifestFilename({})).toBeNull();
    expect(manifestFilename({ filename: '' })).toBeNull();
    expect(manifestFilename({ name: 'Just a name' })).toBeNull();
  });

  it('returns the filename when present', () => {
    expect(manifestFilename({ filename: 'foo.js' })).toBe('foo.js');
  });
});

describe('manifestName', () => {
  it('returns the trimmed name when present', () => {
    expect(manifestName({ name: 'Mushroom' })).toBe('Mushroom');
    expect(manifestName({ name: '   Mushroom   ' })).toBe('Mushroom');
  });

  it('returns null for missing or empty name', () => {
    expect(manifestName({})).toBeNull();
    expect(manifestName({ name: '' })).toBeNull();
    expect(manifestName({ name: '   ' })).toBeNull();
    expect(manifestName(null)).toBeNull();
  });

  it('rejects names with control characters (defence in depth)', () => {
    expect(manifestName({ name: 'bad\x00name' })).toBeNull();
    expect(manifestName({ name: 'newline\nhere' })).toBeNull();
    expect(manifestName({ name: 'tab\there' })).toBeNull();
  });

  it('rejects absurdly long names (likely junk / abuse)', () => {
    expect(manifestName({ name: 'x'.repeat(121) })).toBeNull();
    expect(manifestName({ name: 'x'.repeat(120) })).toBe('x'.repeat(120));
  });

  it('allows unicode (e.g. emoji, accents)', () => {
    expect(manifestName({ name: 'Café ☕' })).toBe('Café ☕');
  });
});
