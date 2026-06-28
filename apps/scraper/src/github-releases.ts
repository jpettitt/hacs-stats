import { type RateLimitGuard, observationFromRestHeaders } from './rate-limit.js';

const USER_AGENT = 'hacs-stats/0.0.0 (+https://hacs-stats.dev)';
const ACCEPT = 'application/vnd.github+json';
const API_VERSION = '2022-11-28';

export interface ReleaseAsset {
  name: string;
  downloadCount: number;
}

export interface ReleaseRecord {
  tag: string;
  /** GitHub release name field — what the author typed in the "Release
   * title" box. Often empty (then tag is the only label). */
  name: string | null;
  /** Release notes markdown body. Used to extract a display title when
   * `name` is empty (first heading or first 60 chars). */
  body: string | null;
  publishedAt: string;
  isPrerelease: boolean;
  htmlUrl: string;
  assets: ReleaseAsset[];
}

export interface FetchReleasesResult {
  /** "modified" → use `releases`; "not-modified" → cached, no work; "missing" → 404. */
  kind: 'modified' | 'not-modified' | 'missing';
  releases?: ReleaseRecord[];
  /** New ETag to persist for next call. Only meaningful on "modified". */
  etag?: string | null;
}

export interface FetchReleasesOptions {
  owner: string;
  name: string;
  token: string;
  /** Previously-stored ETag for If-None-Match. Optional. */
  etag?: string | null;
  /** Inject for tests. */
  fetchImpl?: typeof fetch;
  guard?: RateLimitGuard;
  /** Override per-page size (default 100, max 100). Useful in tests. */
  perPage?: number;
  /** Stop after N pages — safety bound; default 10 (= 1000 releases). */
  maxPages?: number;
}

/** Parse a Link header for the `rel="next"` URL, or null. */
export function parseLinkHeaderNext(link: string | null): string | null {
  if (!link) return null;
  // Format: <https://...?page=2>; rel="next", <https://...>; rel="last"
  for (const part of link.split(',')) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (m) return m[1] ?? null;
  }
  return null;
}

/**
 * Fetch all releases for a repo. Honours ETag — if the server returns 304,
 * we report "not-modified" and the caller skips snapshot writes.
 *
 * Pagination follows the `Link: rel="next"` header. Caps at `maxPages` pages
 * for sanity (no real HACS repo has 1000+ releases, but a buggy upstream
 * shouldn't be able to spin us forever).
 *
 * 404 → "missing" — repo deleted / private / renamed.
 */
export async function fetchReleases(opts: FetchReleasesOptions): Promise<FetchReleasesResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const perPage = opts.perPage ?? 100;
  const maxPages = opts.maxPages ?? 10;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    'User-Agent': USER_AGENT,
    Accept: ACCEPT,
    'X-GitHub-Api-Version': API_VERSION,
  };
  if (opts.etag) headers['If-None-Match'] = opts.etag;

  let url: string | null =
    `https://api.github.com/repos/${opts.owner}/${opts.name}/releases?per_page=${perPage}`;
  const collected: ReleaseRecord[] = [];
  let firstResponseEtag: string | null = null;

  for (let page = 0; page < maxPages && url; page++) {
    // For page 2+ we drop If-None-Match — the ETag is per-resource, and a
    // 304 on page 2 would erase the page-1 releases we already collected.
    const reqHeaders = page === 0 ? headers : { ...headers, 'If-None-Match': '' };
    const res: Response = await fetchImpl(url, { headers: reqHeaders });

    if (opts.guard) {
      const obs = observationFromRestHeaders(res.headers);
      if (obs) opts.guard.observe(obs);
    }

    if (page === 0 && res.status === 304) return { kind: 'not-modified' };
    if (page === 0 && res.status === 404) return { kind: 'missing' };
    if (!res.ok) {
      throw new Error(
        `releases ${res.status} for ${opts.owner}/${opts.name}: ${(await res.text()).slice(0, 200)}`,
      );
    }
    if (page === 0) firstResponseEtag = res.headers.get('etag');

    const body = (await res.json()) as Array<{
      tag_name: string;
      name: string | null;
      body: string | null;
      published_at: string | null;
      prerelease: boolean;
      html_url: string;
      assets: Array<{ name: string; download_count: number }>;
    }>;

    for (const r of body) {
      // Skip drafts (no published_at) — we have no business in unpublished work.
      if (!r.published_at) continue;
      collected.push({
        tag: r.tag_name,
        name: r.name,
        body: r.body,
        publishedAt: r.published_at,
        isPrerelease: r.prerelease,
        htmlUrl: r.html_url,
        assets: r.assets.map((a) => ({ name: a.name, downloadCount: a.download_count })),
      });
    }

    url = parseLinkHeaderNext(res.headers.get('link'));
  }

  return { kind: 'modified', releases: collected, etag: firstResponseEtag };
}
