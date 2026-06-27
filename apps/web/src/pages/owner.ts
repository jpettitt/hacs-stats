import { fmtInt, kindBadge, repoTags } from '../components.js';
import { escapeHtml } from '../sanitize.js';

export interface OwnerRow {
  full_name: string;
  hacs_name: string | null;
  kind: string;
  source: string;
  state: string;
  is_fork: number;
  archived: number;
  stars: number;
  latest_release_downloads: number;
  latest_release_tag: string | null;
  description: string | null;
}

export interface OwnerPageProps {
  owner: string;
  repos: OwnerRow[];
}

export function renderOwnerPage(props: OwnerPageProps): string {
  const safeOwner = escapeHtml(props.owner);
  const ghUrl = `https://github.com/${safeOwner}`;
  if (props.repos.length === 0) {
    return `
      <h2>${safeOwner}</h2>
      <p class="muted">We haven't catalogued any repos from this owner.
        <a href="${ghUrl}" target="_blank" rel="noopener noreferrer">View on GitHub ↗</a></p>`;
  }
  const rows = props.repos
    .map((r) => {
      const safeFull = escapeHtml(r.full_name);
      const safeName = r.hacs_name ? escapeHtml(r.hacs_name) : safeFull;
      const tags = repoTags({ source: r.source, is_fork: r.is_fork, archived: r.archived });
      // Lifecycle hint — most rows are 'active' (no badge); flag the others
      // so the visitor knows why a download/star number might be zero.
      const stateBadge =
        r.state === 'active'
          ? ''
          : ` <span class="badge badge-${escapeHtml(r.state)}">${escapeHtml(r.state)}</span>`;
      const desc = r.description ? escapeHtml(r.description) : '';
      const releaseDl = r.latest_release_tag
        ? `${fmtInt(r.latest_release_downloads)} <span class="muted small">(${escapeHtml(r.latest_release_tag)})</span>`
        : '<span class="muted">—</span>';
      return `<tr>
        <td>
          <a href="/r/${safeFull}">${safeName}</a>${kindBadge(r.kind)}${tags}${stateBadge}
          <div class="muted small">${safeFull}</div>
          ${desc ? `<div class="muted small">${desc}</div>` : ''}
        </td>
        <td class="num">${fmtInt(r.stars)}</td>
        <td class="num">${releaseDl}</td>
      </tr>`;
    })
    .join('');
  return `
    <h2>${safeOwner} <span class="muted small">(${props.repos.length} repo${props.repos.length === 1 ? '' : 's'})</span></h2>
    <p class="muted small"><a href="${ghUrl}" target="_blank" rel="noopener noreferrer">${safeOwner} on GitHub ↗</a></p>
    <table>
      <thead>
        <tr><th>Repo</th><th class="num">Stars</th><th class="num">Downloads (latest)</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}
