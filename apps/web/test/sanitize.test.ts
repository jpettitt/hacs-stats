import { describe, expect, it } from 'vitest';
import { escapeHtml, isSafeRepoFullName, safeGithubRepoUrl } from '../src/sanitize.js';

describe('escapeHtml', () => {
  it('escapes the OWASP-recommended set', () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml(`it's & "ok"`)).toBe('it&#39;s &amp; &quot;ok&quot;');
    expect(escapeHtml('`backtick`')).toBe('&#96;backtick&#96;');
  });

  it('is idempotent on already-safe strings', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123');
  });

  it("escapes ampersand BEFORE other entities (so &lt; doesn't become &amp;lt;)", () => {
    // Sequence-of-replaces ordering: & is first so other replacements that
    // produce '&xxx;' aren't themselves re-escaped.
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('isSafeRepoFullName', () => {
  it('accepts valid owner/repo combos', () => {
    expect(isSafeRepoFullName('jpettitt/weather-radar-card')).toBe(true);
    expect(isSafeRepoFullName('a/b')).toBe(true);
    expect(isSafeRepoFullName('Foo_Bar.42/repo.name-1')).toBe(true);
  });

  it('rejects unusual / dangerous shapes', () => {
    expect(isSafeRepoFullName('')).toBe(false);
    expect(isSafeRepoFullName('no-slash')).toBe(false);
    expect(isSafeRepoFullName('/leading')).toBe(false);
    expect(isSafeRepoFullName('trailing/')).toBe(false);
    expect(isSafeRepoFullName('a/b/c')).toBe(false);
    expect(isSafeRepoFullName('owner/repo?q=1')).toBe(false);
    expect(isSafeRepoFullName('owner/<script>')).toBe(false);
    expect(isSafeRepoFullName('owner/..%2F..%2Fevil.com')).toBe(false);
    expect(isSafeRepoFullName('javascript:alert(1)/x')).toBe(false);
    expect(isSafeRepoFullName('owner/repo space')).toBe(false);
    expect(isSafeRepoFullName('a'.repeat(257))).toBe(false);
  });
});

describe('safeGithubRepoUrl', () => {
  it('returns the URL for valid names', () => {
    expect(safeGithubRepoUrl('jpettitt/weather-radar-card')).toBe(
      'https://github.com/jpettitt/weather-radar-card',
    );
  });

  it('returns null for anything we would not want in an href', () => {
    expect(safeGithubRepoUrl('owner/<script>')).toBeNull();
    expect(safeGithubRepoUrl('javascript:alert(1)/x')).toBeNull();
    expect(safeGithubRepoUrl('owner/..%2F..%2Fevil.com')).toBeNull();
  });
});
