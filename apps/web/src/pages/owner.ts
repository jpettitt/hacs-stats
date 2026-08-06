import { fmtDownloads, fmtInt, kindBadge, repoTags } from '../components.js';
import { type SafeHtml, html } from '../safe-html.js';
import { isSafeRepoFullName } from '../sanitize.js';

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

export function renderOwnerPage(props: OwnerPageProps): SafeHtml {
  // The route validated owner against the GitHub-handle charset, so this
  // URL is well-formed; attribute escaping still applies at interpolation.
  const ghUrl = `https://github.com/${props.owner}`;
  if (props.repos.length === 0) {
    return html`
      <h2>${props.owner}</h2>
      <p class="muted">We haven't catalogued any repos from this owner.
        <a href="${ghUrl}" target="_blank" rel="noopener noreferrer">View on GitHub ↗</a></p>`;
  }
  const rows = props.repos.map((r) => {
    const name = r.hacs_name || r.full_name;
    const tags = repoTags({ source: r.source, is_fork: r.is_fork, archived: r.archived });
    // Lifecycle hint — most rows are 'active' (no badge); flag the others
    // so the visitor knows why a download/star number might be zero.
    const stateBadge =
      r.state === 'active' ? html`` : html` <span class="badge badge-${r.state}">${r.state}</span>`;
    const releaseDl = r.latest_release_tag
      ? html`${fmtDownloads(r.latest_release_downloads)} <span class="muted small">(${r.latest_release_tag})</span>`
      : html`<span class="muted">—</span>`;
    // Guard the /r/<full_name> path with the same shape check the
    // route handler applies — defence in depth, the assertion is free.
    const linkedName = isSafeRepoFullName(r.full_name)
      ? html`<a href="/r/${r.full_name}">${name}</a>`
      : html`<span class="unsafe">${name}</span>`;
    return html`<tr>
        <td>
          ${linkedName}${kindBadge(r.kind)}${tags}${stateBadge}
          <div class="muted small">${r.full_name}</div>
          ${r.description ? html`<div class="muted small">${r.description}</div>` : ''}
        </td>
        <td class="num">${fmtInt(r.stars)}</td>
        <td class="num">${releaseDl}</td>
      </tr>`;
  });
  return html`
    <h2>${props.owner} <span class="muted small">(${props.repos.length} repo${props.repos.length === 1 ? '' : 's'})</span></h2>
    <p class="muted small"><a href="${ghUrl}" target="_blank" rel="noopener noreferrer">${props.owner} on GitHub ↗</a></p>
    <table>
      <thead>
        <tr><th>Repo</th><th class="num">Stars</th><th class="num">Downloads (latest)</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}
