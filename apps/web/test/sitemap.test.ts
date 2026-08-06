import { describe, expect, it } from 'vitest';
import { renderSitemapXml, toLastmodDate, xmlEscape } from '../src/sitemap.js';

describe('renderSitemapXml', () => {
  it('renders a urlset with loc + optional lastmod', () => {
    const xml = renderSitemapXml([
      { loc: 'https://hacs-stats.dev/', lastmod: '2026-08-01' },
      { loc: 'https://hacs-stats.dev/about' },
    ]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain(
      '<url><loc>https://hacs-stats.dev/</loc><lastmod>2026-08-01</lastmod></url>',
    );
    // No fabricated lastmod on the entry that omitted it.
    expect(xml).toContain('<url><loc>https://hacs-stats.dev/about</loc></url>');
    expect(xml).toContain('</urlset>');
  });

  it('escapes XML-special characters in locs', () => {
    const xml = renderSitemapXml([{ loc: 'https://x.dev/?a=1&b=<"y">' }]);
    expect(xml).toContain('https://x.dev/?a=1&amp;b=&lt;&quot;y&quot;&gt;');
    expect(xml).not.toContain('&b=<');
  });
});

describe('toLastmodDate', () => {
  it('reduces ISO timestamps to W3C dates', () => {
    expect(toLastmodDate('2026-08-01T04:12:00.000Z')).toBe('2026-08-01');
  });
  it('returns undefined for null / garbage', () => {
    expect(toLastmodDate(null)).toBeUndefined();
    expect(toLastmodDate(undefined)).toBeUndefined();
    expect(toLastmodDate('not a date')).toBeUndefined();
  });
});

describe('xmlEscape', () => {
  it('escapes all five XML specials', () => {
    expect(xmlEscape(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
});
