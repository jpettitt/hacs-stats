/**
 * schema.org JSON-LD builders for Google rich results.
 *
 * What each page carries:
 *   home            → WebSite (site identity + SearchAction)
 *   /r/:owner/:name → BreadcrumbList + SoftwareApplication
 *   /owner/:owner   → BreadcrumbList
 *
 * Deliberately absent: aggregateRating/review. We have stars, not
 * reviews — mapping stars onto a rating scale would fabricate data and
 * risks a structured-data manual action. InteractionCounter is the
 * honest home for the star count. Consequence (per Google's Software
 * App docs as of 2026-08): a rating or review is REQUIRED for the
 * Software App rich-result treatment, so these pages won't get that
 * SERP badge — the markup is kept as valid entity metadata, and
 * BreadcrumbList (whose requirements we do meet) is the visible win.
 */

import { type SafeHtml, raw } from './safe-html.js';

interface JsonLdObject {
  [key: string]: unknown;
}

/**
 * Serialize JSON-LD blocks into one <script> tag, safe against untrusted
 * strings (repo descriptions etc.) in the values.
 *
 * Why this is sufficient for the script context: inside a <script>
 * element the HTML parser is in script-data state — it decodes no
 * entities and interprets no tags; the ONLY exits are a literal
 * `</script` sequence or `<!--` comment-state trickery. JSON.stringify
 * already neutralises quotes/backslashes/control chars, and escaping
 * every `<` `>` `&` to \uXXXX (lossless inside JSON) removes the bytes
 * those exit sequences need. `>`/`&` aren't strictly required here —
 * they're for the day this JSON gets embedded in a non-script context.
 *
 * Returned as SafeHtml: safe by construction, not by caller diligence.
 * JSON-LD is a non-executing data island, so the strict CSP needs no
 * hash for it.
 */
const JSON_UNICODE: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
};

export function jsonLdScript(blocks: JsonLdObject[]): SafeHtml {
  if (blocks.length === 0) return raw('');
  const payload = blocks.length === 1 ? blocks[0] : blocks;
  const json = JSON.stringify(payload).replace(/[<>&]/g, (ch) => JSON_UNICODE[ch] ?? ch);
  return raw(`<script type="application/ld+json">${json}</script>`);
}

export function webSiteLd(origin: string): JsonLdObject {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'hacs-stats',
    url: `${origin}/`,
    description:
      'Unofficial usage stats for HACS (Home Assistant Community Store) — stars, download trends, and release history for every community integration, plugin, and theme.',
    // Sitelinks-searchbox markup: Google retired the SERP feature in
    // 2024 but the markup is valid schema.org and other engines read it.
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${origin}/search?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  };
}

export interface BreadcrumbItem {
  name: string;
  url: string;
}

export function breadcrumbLd(items: BreadcrumbItem[]): JsonLdObject {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}

export interface SoftwareAppInput {
  fullName: string;
  hacsName: string | null;
  description: string | null;
  /** Human kind label, e.g. "Integration" — becomes applicationSubCategory. */
  kindLabel: string;
  stars: number;
  latestReleaseTag: string | null;
  lastCommitAt: string | null;
  pageUrl: string;
  githubUrl: string;
}

export function softwareAppLd(input: SoftwareAppInput): JsonLdObject {
  const ld: JsonLdObject = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: input.hacsName ?? input.fullName,
    url: input.pageUrl,
    sameAs: input.githubUrl,
    // HACS modules run inside Home Assistant — that IS the platform, and
    // "HomeApplication" is the closest of Google's documented categories.
    applicationCategory: 'HomeApplication',
    applicationSubCategory: input.kindLabel,
    operatingSystem: 'Home Assistant',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: 0, priceCurrency: 'USD' },
    interactionStatistic: {
      '@type': 'InteractionCounter',
      interactionType: 'https://schema.org/LikeAction',
      userInteractionCount: input.stars,
    },
  };
  // Optional fields only when we actually have the data — an explicit
  // null reads as a claim ("version: null") rather than an omission.
  if (input.description) ld.description = input.description;
  if (input.latestReleaseTag) ld.softwareVersion = input.latestReleaseTag;
  if (input.lastCommitAt) ld.dateModified = input.lastCommitAt;
  return ld;
}
