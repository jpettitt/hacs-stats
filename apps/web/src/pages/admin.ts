import { escapeHtml } from '../sanitize.js';

/** Local mirror of the discovery_queue row shape; keeps this file free of
 * direct db-layer typings. */
interface Item {
  url: string;
  source: string;
  status: string;
  discovered_at: string;
  notes: string | null;
  /** Other repos in our catalogue owned by the same GitHub user/org, if any.
   * Surfaced as "Related projects" — gives the admin context for whether
   * the owner is a known prolific HACS contributor or a brand-new face. */
  related?: Array<{ full_name: string; hacs_name: string | null; kind: string }>;
}

export interface AdminPageProps {
  pending: Item[];
  totals: { pending: number; accepted: number; rejected: number; error: number };
  /** Flash message from the prior action (?msg=accepted|rejected|error). */
  flash?: string;
}

function urlToFullName(url: string): string {
  const m = /github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/.exec(url);
  return m?.[1] ?? url;
}

export function renderAdminPage(props: AdminPageProps): string {
  const flash = props.flash ? `<p class="lead">${escapeHtml(props.flash)}</p>` : '';
  const totalsLine = `
    <p class="muted small">
      Queue: <strong>${props.totals.pending}</strong> pending ·
      ${props.totals.accepted} accepted · ${props.totals.rejected} rejected ·
      ${props.totals.error} errored
    </p>`;
  if (props.pending.length === 0) {
    return `
      <h2>Discovery queue</h2>
      ${totalsLine}
      ${flash}
      <p class="muted">No pending candidates. Run <code>pnpm discover</code>
        on the server to look for new ones.</p>`;
  }
  const rows = props.pending
    .map((it) => {
      const safeUrl = escapeHtml(it.url);
      const safeFullName = escapeHtml(urlToFullName(it.url));
      const safeNotes = it.notes ? escapeHtml(it.notes) : '';
      const related =
        it.related && it.related.length > 0
          ? `<div class="related muted small">
              <strong>Related projects from same owner</strong> (${it.related.length}):<br>
              ${it.related
                .slice(0, 8)
                .map(
                  (r) =>
                    `<a href="/r/${escapeHtml(r.full_name)}">${escapeHtml(
                      r.hacs_name && r.hacs_name.length > 0 ? r.hacs_name : r.full_name,
                    )}</a>`,
                )
                .join(', ')}${it.related.length > 8 ? `, +${it.related.length - 8} more` : ''}
            </div>`
          : `<div class="related muted small">First repo we've seen from this owner.</div>`;
      return `<tr>
        <td>
          <a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeFullName}</a>
          ${related}
        </td>
        <td class="kind">${escapeHtml(it.source)}</td>
        <td class="num small">${escapeHtml(it.discovered_at.slice(0, 10))}</td>
        <td class="muted small">${safeNotes}</td>
        <td>
          <form action="/admin/queue/decide" method="post" style="display:inline">
            <input type="hidden" name="url" value="${safeUrl}">
            <input type="hidden" name="decision" value="accept">
            <button type="submit">Accept</button>
          </form>
          <form action="/admin/queue/decide" method="post" style="display:inline">
            <input type="hidden" name="url" value="${safeUrl}">
            <input type="hidden" name="decision" value="reject">
            <button type="submit">Reject</button>
          </form>
        </td>
      </tr>`;
    })
    .join('');
  return `
    <h2>Discovery queue</h2>
    ${totalsLine}
    ${flash}
    <table>
      <thead><tr><th>Repo</th><th>Source</th><th>Discovered</th><th>Notes</th><th>Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}
