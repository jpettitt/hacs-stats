import { describe, expect, it } from 'vitest';
import { breadcrumbLd, jsonLdScript, softwareAppLd, webSiteLd } from '../src/structured-data.js';

describe('jsonLdScript', () => {
  it('blocks </script> breakout from untrusted strings', () => {
    const out = String(
      jsonLdScript([
        softwareAppLd({
          fullName: 'evil/repo',
          hacsName: null,
          description: '</script><script>alert(1)</script>',
          kindLabel: 'Plugin',
          stars: 1,
          latestReleaseTag: null,
          lastCommitAt: null,
          pageUrl: 'https://hacs-stats.dev/r/evil/repo',
          githubUrl: 'https://github.com/evil/repo',
        }),
      ]),
    );
    // The only </script> in the output is the tag's own closer.
    expect(out.indexOf('</script>')).toBe(out.length - '</script>'.length);
    expect(out).toContain('\\u003c/script'); // payload's closing tag arrives escaped
    // Still valid JSON after unwrapping the tag.
    const json = out
      .replace(/^<script type="application\/ld\+json">/, '')
      .replace(/<\/script>$/, '');
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('returns empty for no blocks and unwraps a single block', () => {
    expect(String(jsonLdScript([]))).toBe('');
    const single = String(jsonLdScript([webSiteLd('https://hacs-stats.dev')]));
    expect(single).toContain('"@type":"WebSite"');
    expect(single).not.toContain('['); // single object, not an array
  });
});

describe('softwareAppLd', () => {
  const base = {
    fullName: 'alice/solar-card',
    hacsName: 'Solar Card',
    description: 'A solar card',
    kindLabel: 'Plugin',
    stars: 42,
    latestReleaseTag: 'v1.2.3',
    lastCommitAt: '2026-08-01T00:00:00Z',
    pageUrl: 'https://hacs-stats.dev/r/alice/solar-card',
    githubUrl: 'https://github.com/alice/solar-card',
  };

  it('carries the Google software-app required set (name + offers)', () => {
    const ld = softwareAppLd(base);
    expect(ld.name).toBe('Solar Card');
    expect(ld.offers).toEqual({ '@type': 'Offer', price: 0, priceCurrency: 'USD' });
    expect(ld.softwareVersion).toBe('v1.2.3');
    expect(ld.interactionStatistic).toMatchObject({ userInteractionCount: 42 });
  });

  it('falls back to full_name and omits absent optionals instead of null-ing them', () => {
    const ld = softwareAppLd({
      ...base,
      hacsName: null,
      description: null,
      latestReleaseTag: null,
      lastCommitAt: null,
    });
    expect(ld.name).toBe('alice/solar-card');
    expect('description' in ld).toBe(false);
    expect('softwareVersion' in ld).toBe(false);
    expect('dateModified' in ld).toBe(false);
  });
});

describe('breadcrumbLd', () => {
  it('numbers positions from 1 in order', () => {
    const ld = breadcrumbLd([
      { name: 'Home', url: 'https://x.dev/' },
      { name: 'Plugin', url: 'https://x.dev/search?kind=plugin' },
      { name: 'Solar Card', url: 'https://x.dev/r/a/b' },
    ]) as { itemListElement: Array<{ position: number; name: string }> };
    expect(ld.itemListElement.map((e) => e.position)).toEqual([1, 2, 3]);
    expect(ld.itemListElement[2]?.name).toBe('Solar Card');
  });
});
