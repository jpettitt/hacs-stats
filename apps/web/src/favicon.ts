/**
 * Inline SVG logos. Two candidates served as `/favicon.svg` and
 * `/favicon-alt.svg` so the maintainer can preview both at once and
 * pick a winner before we commit to one. Whichever wins becomes the
 * permanent favicon + header mark.
 *
 * Both designs:
 *   - 24×24 viewBox; scales cleanly from 16px favicon to 32px header.
 *   - Use currentColor so the same SVG renders in the link colour for
 *     the header (where it sits next to the wordmark) and resolves to
 *     the explicit fill below for browser tab / OS icon contexts where
 *     currentColor doesn't apply.
 *   - No external references; safe under the strict CSP.
 */

/** Plain ascending bars on a filled rounded-square background. The
 * background is essential — without it the bars vanish on dark OS
 * themes (the favicon has no contrast against the browser-tab area)
 * and on coloured browser-chrome themes like Chrome's "blue" theme,
 * where blue-on-blue is invisible. Containing the mark in its own
 * tile is the standard pattern for that reason (think GitHub's, Notion's
 * favicons). */
export const FAVICON_BARS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-label="hacs-stats">
  <rect width="24" height="24" rx="4" fill="#2563eb"/>
  <rect x="4"  y="14" width="4" height="7"  rx="0.6" fill="#ffffff"/>
  <rect x="10" y="10" width="4" height="11" rx="0.6" fill="#ffffff"/>
  <rect x="16" y="6"  width="4" height="15" rx="0.6" fill="#ffffff"/>
</svg>`;

/** The one live in <link rel="icon"> and the header. Single design now;
 * keeping the constant in case we want a per-context variant later. */
export const FAVICON_LIVE = FAVICON_BARS;
