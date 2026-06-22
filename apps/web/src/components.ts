import { escapeHtml, safeGithubRepoUrl } from './sanitize.js';

/**
 * A minimal shape every list/table renderer reads. The various DB queries
 * return supersets of this — TypeScript is happy with structural matching.
 * Declared locally rather than imported from `@hacs-stats/db` to keep this
 * file independent of the DB layer's exact row types.
 */
export interface RowForList {
  full_name: string;
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

export function repoLink(fullName: string): string {
  const safeText = escapeHtml(fullName);
  const ghUrl = safeGithubRepoUrl(fullName);
  if (!ghUrl) return `<span class="repo-name unsafe">${safeText}</span>`;
  // Same allow-list keeps the internal href safe too.
  return `<a href="/r/${fullName}">${safeText}</a>`;
}

export function kindLabel(kind: string): string {
  return escapeHtml(KIND_LABEL[kind] ?? kind);
}

export interface LeaderTableOptions {
  valueLabel: string;
  formatValue: (r: RowForList) => string;
  /** Hide the stars-delta column when sorting by stars (it would be redundant). */
  showStarDelta?: boolean;
}

export function renderLeaderTable(rows: RowForList[], opts: LeaderTableOptions): string {
  const showDelta = opts.showStarDelta ?? true;
  const head = `<tr>
    <th>Repo</th><th>Kind</th>
    <th class="num">${escapeHtml(opts.valueLabel)}</th>
    ${showDelta ? '<th class="num">Stars Δ30d</th>' : ''}
  </tr>`;
  const body = rows
    .map(
      (r) => `<tr>
        <td>${repoLink(r.full_name)}</td>
        <td class="kind">${kindLabel(r.kind)}</td>
        <td class="num">${escapeHtml(opts.formatValue(r))}</td>
        ${showDelta ? `<td class="num small">${escapeHtml(fmtDelta(r.star_delta_30d))}</td>` : ''}
      </tr>`,
    )
    .join('');
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}
