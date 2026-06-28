/**
 * Rendering-time hardening for untrusted strings.
 *
 * Everything in our DB ultimately came from GitHub (repo names, release tags,
 * asset filenames, descriptions). GitHub validates most of these, but we
 * treat them as untrusted at the render boundary anyway — defense in depth
 * for the day someone files a "repo with a name like <script>alert(1)</script>"
 * report.
 */

/** HTML text/attribute context. Covers the OWASP recommended set. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

/**
 * GitHub's own rules for owner + repo names (per the API docs and observed
 * behaviour): ASCII letters, digits, hyphen, underscore, period. Owner
 * names additionally allow nothing fancier than that. We accept the same
 * set on each side of the slash.
 *
 * Anything outside the set is rejected — we'd rather render `[invalid]` than
 * trust a row that came in with weird characters.
 */
const SAFE_PART = /^[A-Za-z0-9._-]+$/;

export function isSafeRepoFullName(fullName: string): boolean {
  if (typeof fullName !== 'string') return false;
  // GitHub repo names cap at ~100 chars; allow some slack.
  if (fullName.length === 0 || fullName.length > 256) return false;
  const slash = fullName.indexOf('/');
  if (slash <= 0 || slash !== fullName.lastIndexOf('/')) return false;
  const owner = fullName.slice(0, slash);
  const name = fullName.slice(slash + 1);
  return SAFE_PART.test(owner) && SAFE_PART.test(name);
}

/**
 * Build a safe `https://github.com/<owner>/<name>` URL or return null if the
 * fullName fails validation. Returning null lets the caller render plain
 * text instead of a malformed link.
 */
export function safeGithubRepoUrl(fullName: string): string | null {
  if (!isSafeRepoFullName(fullName)) return null;
  // No need for encodeURIComponent on a known-safe character set, but we'd
  // need it the moment we accept anything broader.
  return `https://github.com/${fullName}`;
}

/**
 * Accept a URL only if it canonicalises to `https://github.com/<owner>/<name>`
 * exactly — no other host, no path / query / fragment beyond the repo root.
 * Used to sanitise href targets built from `discovery_queue.url` (admin or
 * code-search supplied) before they reach `<a href="…">`.
 *
 * escapeHtml() on its own defeats attribute-quote breakout but does NOT
 * block `javascript:` / `data:` schemes, nor a path-traversal to a
 * different github.com subpath. Returns the canonical URL on success,
 * null otherwise; caller renders plain text on null.
 */
export function safeHttpsGithubUrl(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > 256) return null;
  const PREFIX = 'https://github.com/';
  if (!raw.startsWith(PREFIX)) return null;
  const tail = raw.slice(PREFIX.length);
  // Reject any path/query/fragment beyond the repo root — we want exactly
  // owner/name. Block trailing slash too; canonical URLs don't have it.
  if (tail.includes('?') || tail.includes('#') || tail.endsWith('/')) return null;
  return isSafeRepoFullName(tail) ? `${PREFIX}${tail}` : null;
}
