/**
 * Sitemap XML rendering — pure functions, no DB access, so tests can
 * exercise the exact bytes Google sees.
 *
 * One flat <urlset> is fine at our scale (~7k repos + ~4k owners); the
 * protocol caps a single file at 50k URLs / 50MB. renderSitemapXml
 * warns (but still renders) past the URL cap so the overflow is visible
 * in server logs long before Google starts truncating.
 */

export interface SitemapUrl {
  /** Absolute URL. */
  loc: string;
  /** W3C date (YYYY-MM-DD) or full ISO timestamp. Omit when unknown —
   * an absent lastmod is better than a fabricated one. */
  lastmod?: string | undefined;
}

const SITEMAP_URL_CAP = 50_000;

/** Minimal XML text escape. Repo/owner names are already constrained to
 * [A-Za-z0-9._-] by our route validation, so this is defence in depth
 * against a future URL shape, not a load-bearing sanitiser. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderSitemapXml(urls: SitemapUrl[]): string {
  if (urls.length > SITEMAP_URL_CAP) {
    console.warn(
      `sitemap: ${urls.length} URLs exceeds the ${SITEMAP_URL_CAP} single-file cap — time to split into a sitemap index`,
    );
  }
  const entries = urls
    .map((u) => {
      const lastmod = u.lastmod ? `<lastmod>${xmlEscape(u.lastmod)}</lastmod>` : '';
      return `<url><loc>${xmlEscape(u.loc)}</loc>${lastmod}</url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

/** Reduce an ISO timestamp to the W3C date Google actually reads.
 * Sub-day precision is noise for a nightly-scraped catalogue. */
export function toLastmodDate(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return iso.slice(0, 10);
}
