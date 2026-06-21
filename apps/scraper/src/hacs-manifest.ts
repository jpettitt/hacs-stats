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
