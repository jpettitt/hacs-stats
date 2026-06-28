/**
 * Tiny HTTP caching helpers — Last-Modified + If-Modified-Since.
 *
 * Our data is updated by the nightly scrape (one row per repo per day),
 * so most page renders return identical bytes to the prior load. Letting
 * Cloudflare and the browser short-circuit with 304s means the origin
 * does NO work for the common "user-already-saw-this" case.
 *
 * Usage in a route handler:
 *
 *   const lm = repoLastModified(detail.last_scraped_at);
 *   if (notModifiedSince(c, lm)) return c.body(null, 304);
 *   setCacheHeaders(c, lm, { sMaxAge: 3600 });
 *   return c.html(...);
 *
 * Keep this file free of route-specific logic; callers compute their
 * own Last-Modified timestamp from whatever data drives their page.
 */
import type { Context } from 'hono';

export interface CacheOpts {
  /** Browser cache TTL in seconds. Conservative — invalidation on the
   * client is best-effort anyway since Last-Modified handles revalidation. */
  maxAge?: number;
  /** Cloudflare edge cache TTL in seconds. Longer is fine because we
   * stamp Last-Modified per resource — CF revalidates with origin via
   * If-Modified-Since and we return 304 quickly when nothing changed. */
  sMaxAge?: number;
}

const DEFAULT_OPTS: Required<CacheOpts> = {
  maxAge: 60,
  sMaxAge: 3600,
};

/** Format a Date as an RFC 7231 HTTP-date (e.g. "Sat, 28 Jun 2026 14:23:00 GMT"). */
export function httpDate(d: Date): string {
  return d.toUTCString();
}

/**
 * Returns true if the request's `If-Modified-Since` is >= the supplied
 * last-modified date — i.e. the client already has a fresh copy and
 * we should send 304. Tolerates malformed / missing headers (returns
 * false in those cases — never claim fresh when uncertain).
 */
export function notModifiedSince(c: Context, lastModified: Date): boolean {
  const ims = c.req.header('if-modified-since');
  if (!ims) return false;
  const ts = Date.parse(ims);
  if (!Number.isFinite(ts)) return false;
  // HTTP-date is second-resolution; compare seconds, not ms.
  return Math.floor(ts / 1000) >= Math.floor(lastModified.getTime() / 1000);
}

/**
 * Set Last-Modified and Cache-Control on the response. Call before
 * sending the body.
 */
export function setCacheHeaders(c: Context, lastModified: Date, opts: CacheOpts = {}): void {
  const { maxAge, sMaxAge } = { ...DEFAULT_OPTS, ...opts };
  c.header('Last-Modified', httpDate(lastModified));
  c.header('Cache-Control', `public, max-age=${maxAge}, s-maxage=${sMaxAge}`);
  // Vary on Accept-Encoding so CF caches gzipped vs raw separately
  // (browsers always send AE; CF compresses based on its rules; spelling
  // this out keeps mixed-CDN setups from serving the wrong representation).
  c.header('Vary', 'Accept-Encoding');
}

/** Parse a SQL ISO timestamp ("2026-06-28T04:00:00.000Z") into a Date.
 * Null-safe: returns `now` when the timestamp is missing. */
export function parseTimestamp(iso: string | null | undefined): Date {
  if (!iso) return new Date();
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return new Date();
  return new Date(t);
}
