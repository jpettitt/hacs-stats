import { describe, expect, it } from 'vitest';
import { fetchDefaultList } from '../src/hacs-default.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('fetchDefaultList', () => {
  it('parses a well-formed list', async () => {
    const fetchImpl = async () =>
      jsonResponse(['jpettitt/weather-radar-card', 'thomasloven/lovelace-card-mod']);
    const entries = await fetchDefaultList('plugin', { fetchImpl });
    expect(entries).toEqual([
      {
        kind: 'plugin',
        owner: 'jpettitt',
        name: 'weather-radar-card',
        fullName: 'jpettitt/weather-radar-card',
      },
      {
        kind: 'plugin',
        owner: 'thomasloven',
        name: 'lovelace-card-mod',
        fullName: 'thomasloven/lovelace-card-mod',
      },
    ]);
  });

  it('drops malformed entries instead of throwing', async () => {
    const fetchImpl = async () =>
      jsonResponse([
        'good/repo',
        'bad-no-slash',
        '/leading-slash',
        'trailing/',
        'a/b/c-too-many-slashes',
        42,
        null,
        '',
      ]);
    const entries = await fetchDefaultList('integration', { fetchImpl });
    expect(entries.map((e) => e.fullName)).toEqual(['good/repo']);
  });

  it('throws when the response is not an array', async () => {
    const fetchImpl = async () => jsonResponse({ not: 'an array' });
    await expect(fetchDefaultList('plugin', { fetchImpl })).rejects.toThrow(/expected JSON array/);
  });

  it('uses /HEAD/ so the upstream default branch can change', async () => {
    let observed = '';
    const fetchImpl: typeof fetch = async (input) => {
      observed = String(input);
      return jsonResponse([]);
    };
    await fetchDefaultList('theme', { fetchImpl });
    expect(observed).toBe('https://raw.githubusercontent.com/hacs/default/HEAD/theme');
  });
});
