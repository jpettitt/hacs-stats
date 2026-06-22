import { describe, expect, it } from 'vitest';
import { fetchReleases, parseLinkHeaderNext } from '../src/github-releases.js';

function jsonRes(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

describe('parseLinkHeaderNext', () => {
  it('extracts rel="next" from a multi-link header', () => {
    expect(
      parseLinkHeaderNext(
        '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=10>; rel="last"',
      ),
    ).toBe('https://api.github.com/x?page=2');
  });

  it('returns null when there is no next link', () => {
    expect(parseLinkHeaderNext('<https://x>; rel="last"')).toBeNull();
    expect(parseLinkHeaderNext(null)).toBeNull();
    expect(parseLinkHeaderNext('')).toBeNull();
  });
});

describe('fetchReleases', () => {
  const baseOpts = { owner: 'a', name: 'b', token: 'tok' };

  it('returns "not-modified" on 304', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(null, { status: 304, headers: { etag: 'W/"abc"' } });
    const res = await fetchReleases({ ...baseOpts, etag: 'W/"abc"', fetchImpl });
    expect(res.kind).toBe('not-modified');
  });

  it('returns "missing" on 404', async () => {
    const fetchImpl: typeof fetch = async () => new Response('not found', { status: 404 });
    const res = await fetchReleases({ ...baseOpts, fetchImpl });
    expect(res.kind).toBe('missing');
  });

  it('parses a single-page response into ReleaseRecords', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonRes(
        [
          {
            tag_name: 'v1.0.0',
            published_at: '2026-06-20T10:00:00Z',
            prerelease: false,
            html_url: 'https://github.com/a/b/releases/tag/v1.0.0',
            assets: [
              { name: 'card.js', download_count: 123 },
              { name: 'card.js.gz', download_count: 9 },
            ],
          },
        ],
        200,
        { etag: 'W/"fresh"' },
      );
    const res = await fetchReleases({ ...baseOpts, fetchImpl });
    expect(res.kind).toBe('modified');
    expect(res.etag).toBe('W/"fresh"');
    expect(res.releases).toEqual([
      {
        tag: 'v1.0.0',
        publishedAt: '2026-06-20T10:00:00Z',
        isPrerelease: false,
        htmlUrl: 'https://github.com/a/b/releases/tag/v1.0.0',
        assets: [
          { name: 'card.js', downloadCount: 123 },
          { name: 'card.js.gz', downloadCount: 9 },
        ],
      },
    ]);
  });

  it('skips drafts (no published_at)', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonRes([
        {
          tag_name: 'draft',
          published_at: null,
          prerelease: false,
          html_url: '',
          assets: [],
        },
        {
          tag_name: 'v1',
          published_at: '2026-06-20T10:00:00Z',
          prerelease: false,
          html_url: 'https://example/v1',
          assets: [],
        },
      ]);
    const res = await fetchReleases({ ...baseOpts, fetchImpl });
    expect(res.releases?.map((r) => r.tag)).toEqual(['v1']);
  });

  it('follows Link: rel="next" pagination', async () => {
    let call = 0;
    const fetchImpl: typeof fetch = async () => {
      call++;
      if (call === 1) {
        return jsonRes(
          [
            {
              tag_name: 'v1',
              published_at: '2026-06-20T10:00:00Z',
              prerelease: false,
              html_url: '',
              assets: [],
            },
          ],
          200,
          { link: '<https://api.github.com/page2>; rel="next"' },
        );
      }
      return jsonRes([
        {
          tag_name: 'v2',
          published_at: '2026-06-21T10:00:00Z',
          prerelease: false,
          html_url: '',
          assets: [],
        },
      ]);
    };
    const res = await fetchReleases({ ...baseOpts, fetchImpl });
    expect(res.kind).toBe('modified');
    expect(res.releases?.map((r) => r.tag)).toEqual(['v1', 'v2']);
    expect(call).toBe(2);
  });

  it('sends If-None-Match only on the first request', async () => {
    const sentIfNoneMatch: (string | null)[] = [];
    let call = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      call++;
      const headers = init?.headers as Record<string, string>;
      sentIfNoneMatch.push(headers['If-None-Match'] ?? null);
      if (call === 1) {
        return jsonRes(
          [
            {
              tag_name: 'v1',
              published_at: '2026-06-20T10:00:00Z',
              prerelease: false,
              html_url: '',
              assets: [],
            },
          ],
          200,
          { link: '<https://api.github.com/page2>; rel="next"' },
        );
      }
      return jsonRes([]);
    };
    await fetchReleases({ ...baseOpts, etag: 'W/"v1"', fetchImpl });
    expect(sentIfNoneMatch).toEqual(['W/"v1"', '']);
  });

  it('caps at maxPages to prevent runaway loops', async () => {
    let call = 0;
    const fetchImpl: typeof fetch = async () => {
      call++;
      return jsonRes(
        [
          {
            tag_name: `v${call}`,
            published_at: '2026-06-20T10:00:00Z',
            prerelease: false,
            html_url: '',
            assets: [],
          },
        ],
        200,
        { link: '<https://api.github.com/next>; rel="next"' },
      );
    };
    const res = await fetchReleases({ ...baseOpts, fetchImpl, maxPages: 3 });
    expect(call).toBe(3);
    expect(res.releases?.length).toBe(3);
  });
});
