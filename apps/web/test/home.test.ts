import { describe, expect, it } from 'vitest';
import { type LeaderRow, renderHome } from '../src/pages/home.js';

const MALICIOUS_ROWS: LeaderRow[] = [
  {
    // Repo name with classic XSS payload.
    full_name: `evil/<script>alert('xss')</script>`,
    kind: '<img src=x onerror=alert(1)>',
    stars: 1,
    downloads_30d: 0,
    star_delta_30d: 0,
    top_version_30d: null,
  },
  {
    // Repo name that looks like a path-traversal redirect — must NOT end up in href.
    full_name: 'owner/..%2F..%2Fevil.com',
    kind: 'plugin',
    stars: 1,
    downloads_30d: 0,
    star_delta_30d: 0,
    top_version_30d: null,
  },
  {
    // Quote breakout attempt.
    full_name: `breakout/repo"><img onerror=alert(2) src=`,
    kind: 'plugin',
    stars: 1,
    downloads_30d: 0,
    star_delta_30d: 0,
    top_version_30d: null,
  },
];

describe('renderHome — XSS resistance', () => {
  const html = renderHome({
    repoCount: MALICIOUS_ROWS.length,
    topByStars: MALICIOUS_ROWS,
    topByDownloads: MALICIOUS_ROWS,
    trendingByStars: MALICIOUS_ROWS,
    newArrivals: MALICIOUS_ROWS,
    recentlyUpdated: MALICIOUS_ROWS,
  });

  it('never emits a raw <script> from malicious data', () => {
    // The literal payload string is the only place "<script>" could appear;
    // assert it's escaped everywhere.
    expect(html).not.toMatch(/<script>alert/);
  });

  it('escapes < > " \' in malicious repo names and kinds', () => {
    expect(html).toContain('&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('does NOT produce an external <a href> for invalid repo names', () => {
    // safeGithubRepoUrl rejects all three malicious names, so each renders as
    // a <span class="repo-name unsafe"> instead.
    expect(html).toContain('<span class="repo-name unsafe">');
    // And there's no href= pointing at our malicious payloads.
    expect(html).not.toMatch(/href="[^"]*evil\.com/);
    expect(html).not.toMatch(/href="[^"]*<script/i);
    expect(html).not.toMatch(/href="[^"]*onerror/i);
  });

  it('still links to /r/owner/name for a well-formed repo name', () => {
    const okRow = {
      full_name: 'jpettitt/weather-radar-card',
      kind: 'plugin',
      stars: 100,
      downloads_30d: 0,
      star_delta_30d: 0,
      top_version_30d: null,
    };
    const safeHtml = renderHome({
      repoCount: 1,
      topByStars: [okRow],
      topByDownloads: [okRow],
      trendingByStars: [],
      newArrivals: [],
      recentlyUpdated: [],
    });
    expect(safeHtml).toContain('href="/r/jpettitt/weather-radar-card"');
  });

  it('shows the hacs_name when provided, with owner/repo as muted subtitle', () => {
    const html = renderHome({
      repoCount: 1,
      topByStars: [
        {
          full_name: 'piitaya/lovelace-mushroom',
          hacs_name: 'Mushroom',
          kind: 'plugin',
          stars: 100,
          downloads_30d: 0,
          star_delta_30d: 0,
          top_version_30d: null,
        },
      ],
      topByDownloads: [],
      trendingByStars: [],
      newArrivals: [],
      recentlyUpdated: [],
    });
    expect(html).toContain('Mushroom');
    expect(html).toContain('(piitaya/lovelace-mushroom)');
    expect(html).toContain('class="repo-display"');
  });

  it('escapes a malicious hacs_name', () => {
    const html = renderHome({
      repoCount: 1,
      topByStars: [
        {
          full_name: 'attacker/repo',
          hacs_name: '<script>alert(1)</script>',
          kind: 'plugin',
          stars: 1,
          downloads_30d: 0,
          star_delta_30d: 0,
          top_version_30d: null,
        },
      ],
      topByDownloads: [],
      trendingByStars: [],
      newArrivals: [],
      recentlyUpdated: [],
    });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
