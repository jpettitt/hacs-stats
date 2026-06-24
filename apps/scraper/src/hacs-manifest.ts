import { type FetchTextOptions, HttpError, fetchText } from './http.js';

/**
 * Subset of the `hacs.json` schema we care about today. HACS allows many more
 * fields (homeassistant, hacs, render_readme, zip_release, country, …); we
 * only persist `filename` in Phase 2 because that's what tells us which asset
 * to count downloads for. Other fields will get pulled in as we need them.
 */
export interface HacsManifest {
  name?: string;
  /** Asset name HACS downloads. Optional — many plugins rely on naming convention. */
  filename?: string;
  /** True if HACS should pull the whole zip release. Integrations usually set this. */
  zip_release?: boolean;
  /** Minimum Home Assistant version. We don't enforce it, just record it. */
  homeassistant?: string;
}

/**
 * Fetch a repo's `hacs.json` from the default branch.
 *
 * Returns null for:
 *   - 404 (repo has no hacs.json — happens for some custom/legacy plugins)
 *   - any other 4xx (rename, archive, private — treat as "no manifest")
 *   - JSON parse failure (corrupt or empty file)
 *
 * 5xx is retried by fetchText. If we still fail after retries, the error
 * propagates and the caller's `mapLimit` records it as a per-item failure.
 */
export async function fetchHacsManifest(
  fullName: string,
  opts: FetchTextOptions = {},
): Promise<HacsManifest | null> {
  const url = `https://raw.githubusercontent.com/${fullName}/HEAD/hacs.json`;
  let text: string;
  try {
    text = await fetchText(url, opts);
  } catch (err) {
    if (err instanceof HttpError && err.status >= 400 && err.status < 500) return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    // typeof [] === 'object', so arrays sneak past a plain object check.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as HacsManifest;
  } catch {
    return null;
  }
}

/** Convenience: just the filename, or null. Most callers only need this. */
export function manifestFilename(manifest: HacsManifest | null): string | null {
  if (!manifest) return null;
  return typeof manifest.filename === 'string' && manifest.filename.length > 0
    ? manifest.filename
    : null;
}

/**
 * Returns true if the string contains any ASCII control character (0x00-0x1F
 * or 0x7F). Done as a charCode scan rather than a regex to dodge Biome's
 * "no control characters in regex" warning — the regex form is technically
 * fine for this use, but the lint message would have to be ignored on every
 * future maintainer, and a small loop is just as clear.
 */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Display name from `hacs.json`. Trimmed; rejected when:
 *   - missing or non-string
 *   - empty after trim
 *   - longer than 120 chars (almost certainly junk / abuse)
 *   - contains ASCII control characters (defence in depth — the render
 *     layer escapes too, but we'd rather not store nasties in the first place)
 *
 * Unicode (emoji, accented letters, etc.) is allowed.
 */
export function manifestName(manifest: HacsManifest | null): string | null {
  if (!manifest || typeof manifest.name !== 'string') return null;
  const trimmed = manifest.name.trim();
  if (trimmed.length === 0 || trimmed.length > 120) return null;
  if (hasControlChar(trimmed)) return null;
  return trimmed;
}
