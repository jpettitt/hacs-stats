import { kindLabel, repoLink } from '../components.js';
import { escapeHtml } from '../sanitize.js';

export interface SearchHit {
  full_name: string;
  hacs_name: string | null;
  kind: string;
  description: string | null;
}

export interface SearchPageProps {
  query: string;
  hits: SearchHit[];
}

export function renderSearchPage(props: SearchPageProps): string {
  if (!props.query) {
    return `<p class="muted">Type something in the search box above.</p>`;
  }
  const q = escapeHtml(props.query);
  if (props.hits.length === 0) {
    return `<p>No repos match <code>${q}</code>.</p>`;
  }
  const rows = props.hits
    .map(
      (h) => `<tr>
        <td>${repoLink(h.full_name, h.hacs_name)}</td>
        <td class="kind">${kindLabel(h.kind)}</td>
        <td>${h.description ? escapeHtml(h.description) : ''}</td>
      </tr>`,
    )
    .join('');
  return `
    <h2>${props.hits.length} result${props.hits.length === 1 ? '' : 's'} for <code>${q}</code></h2>
    <table>
      <thead><tr><th>Repo</th><th>Kind</th><th>Description</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}
