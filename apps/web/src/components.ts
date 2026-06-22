import { escapeHtml, safeGithubRepoUrl } from './sanitize.js';

/**
 * A minimal shape every list/table renderer reads. The various DB queries
 * return supersets of this — TypeScript is happy with structural matching.
 * Declared locally rather than imported from `@hacs-stats/db` to keep this
 * file independent of the DB layer's exact row types.
 */
export interface RowForList {
  full_name: string;
  /** Display name from the repo's hacs.json. null when not set / not yet backfilled. */
  hacs_name?: string | null;
  kind: string;
  stars: number;
  downloads_30d: number;
  star_delta_30d: number;
  top_version_30d: string | null;
  description?: string | null;
  last_commit_at?: string | null;
  first_seen_at?: string;
}

const KIND_LABEL: Record<string, string> = {
  integration: 'Integration',
  plugin: 'Plugin',
  theme: 'Theme',
  appdaemon: 'AppDaemon',
  netdaemon: 'NetDaemon',
  python_script: 'Python script',
  template: 'Template',
};

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

export function fmtDelta(n: number): string {
  if (n === 0) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${fmtInt(n)}`;
}

/**
 * Render the canonical repo identifier. When the repo declared a `name` in
 * its `hacs.json`, we show that prominently with the owner/repo in a muted
 * sub-line; otherwise just the owner/repo. The link target is the internal
 * detail page when the name passes the strict GitHub-name validator,
 * otherwise an inert <span> (defence-in-depth — the same name reaches the
 * URL path and we don't want anything weird in there).
 */
export function repoLink(fullName: string, hacsName?: string | null): string {
  const safeFull = escapeHtml(fullName);
  const ghUrl = safeGithubRepoUrl(fullName);
  if (!ghUrl) {
    // Invalid name — render plain text, no link. We deliberately do NOT
    // surface hacs_name here either, because if the full_name is unsafe the
    // hacs_name is also untrusted (same data plane).
    return `<span class="repo-name unsafe">${safeFull}</span>`;
  }
  if (hacsName && hacsName.length > 0) {
    const safeName = escapeHtml(hacsName);
    return `<a class="repo-name" href="/r/${fullName}"><span class="repo-display">${safeName}</span> <span class="repo-slug muted small">(${safeFull})</span></a>`;
  }
  return `<a class="repo-name" href="/r/${fullName}">${safeFull}</a>`;
}

export function kindLabel(kind: string): string {
  return escapeHtml(KIND_LABEL[kind] ?? kind);
}

export interface LeaderTableOptions {
  valueLabel: string;
  formatValue: (r: RowForList) => string;
  /** Hide the stars-delta column when sorting by stars (it would be redundant). */
  showStarDelta?: boolean;
  /** Show the description column. Default true. Disable for compact tables. */
  showDescription?: boolean;
}

/** Truncate long descriptions for compact display in tables. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

export function renderLeaderTable(rows: RowForList[], opts: LeaderTableOptions): string {
  const showDelta = opts.showStarDelta ?? true;
  const showDesc = opts.showDescription ?? true;
  const head = `<tr>
    <th>Repo</th>
    ${showDesc ? '<th class="desc-col">Description</th>' : ''}
    <th>Kind</th>
    <th class="num">${escapeHtml(opts.valueLabel)}</th>
    ${showDelta ? '<th class="num">Stars Δ30d</th>' : ''}
  </tr>`;
  const body = rows
    .map(
      (r) => `<tr>
        <td>${repoLink(r.full_name, r.hacs_name)}</td>
        ${showDesc ? `<td class="desc-col muted small">${r.description ? escapeHtml(clip(r.description, 110)) : ''}</td>` : ''}
        <td class="kind">${kindLabel(r.kind)}</td>
        <td class="num">${escapeHtml(opts.formatValue(r))}</td>
        ${showDelta ? `<td class="num small">${escapeHtml(fmtDelta(r.star_delta_30d))}</td>` : ''}
      </tr>`,
    )
    .join('');
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}
