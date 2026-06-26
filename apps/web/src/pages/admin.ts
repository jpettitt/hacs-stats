import { fmtInt, renderLeaderTable, renderPagination } from '../components.js';
import { escapeHtml } from '../sanitize.js';

/** Row shape consumed by renderLeaderTable — mirrors what the search /
 * category pages pass in. The accepted-tab listing repurposes that
 * component so the row format matches other listing pages on the site. */
interface ListingRow {
  full_name: string;
  hacs_name: string | null;
  kind: string;
  source: string;
  is_fork: number;
  archived: number;
  description: string | null;
  stars: number;
  star_delta_30d: number;
  latest_release_downloads: number;
  latest_release_tag: string | null;
  downloads_30d: number;
  top_version_30d: string | null;
}

/** Local mirror of the discovery_queue row shape; keeps this file free of
 * direct db-layer typings. */
interface Item {
  url: string;
  source: string;
  status: string;
  discovered_at: string;
  notes: string | null;
  stars: number | null;
  pushed_at: string | null;
  description: string | null;
  /** Other repos in our catalogue owned by the same GitHub user/org, if any.
   * Surfaced as "Related projects" — gives the admin context for whether
   * the owner is a known prolific HACS contributor or a brand-new face. */
  related?: Array<{ full_name: string; hacs_name: string | null; kind: string }>;
}

/** "N days ago" / "today" formatter. Discovery-queue freshness signal —
 * absolute dates lose intuition fast ("2026-05-02" — is that recent?). */
function fmtPushedAgo(iso: string | null, nowMs: number): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const days = Math.floor((nowMs - t) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} mo ago`;
  return `${(days / 365).toFixed(1)} yr ago`;
}

export interface AdminPageProps {
  /** Rows for the currently-selected status (variable name kept for diff
   * continuity — may contain accepted/rejected/error rows too). */
  pending: Item[];
  totals: { pending: number; accepted: number; rejected: number; error: number };
  /** Which status the page is currently filtered to. Drives the tab UI and
   * suppresses the accept/reject buttons for non-pending rows. */
  status: 'pending' | 'accepted' | 'rejected' | 'error';
  /** Sort column the rows came back in — drives the active state on column
   * headers. */
  sort: 'discovered' | 'stars' | 'pushed';
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
  /** Flash message from the prior action (?msg=accepted|rejected|error). */
  flash?: string;
  /** When provided (accepted tab only), the page renders these via the
   * shared renderLeaderTable instead of the queue-style table — so the
   * accepted list reads like every other listing page on the site. */
  listingRows?: ListingRow[];
}

function urlToFullName(url: string): string {
  const m = /github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/.exec(url);
  return m?.[1] ?? url;
}

export function renderAdminPage(props: AdminPageProps): string {
  const flash = props.flash ? `<p class="lead">${escapeHtml(props.flash)}</p>` : '';
  // Tabs let the admin browse audit-trail rows (auto-approved, manually
  // accepted, rejected) — not just the pending work queue. Each tab is a
  // plain link so the URL is shareable.
  // Tabs preserve sort/dir so flipping from "pending sorted by stars desc"
  // to "accepted sorted by stars desc" keeps the lens. Page resets to 1
  // intentionally — a tab switch is conceptually a new view.
  const tab = (
    key: 'pending' | 'accepted' | 'rejected' | 'error',
    label: string,
    count: number,
  ) => {
    const active = props.status === key;
    const href = `/admin/queue?status=${key}&sort=${props.sort}&dir=${props.dir}`;
    return `<a href="${href}" class="${active ? 'tab tab-active' : 'tab'}">${label} <span class="muted small">(${count})</span></a>`;
  };
  const tabs = `
    <nav class="tabs">
      ${tab('pending', 'Pending', props.totals.pending)}
      ${tab('accepted', 'Accepted', props.totals.accepted)}
      ${tab('rejected', 'Rejected', props.totals.rejected)}
      ${tab('error', 'Errored', props.totals.error)}
    </nav>`;
  if (props.pending.length === 0) {
    return `
      <h2>Discovery queue</h2>
      ${tabs}
      ${flash}
      <p class="muted">No <strong>${escapeHtml(props.status)}</strong> rows.
        Run <code>pnpm discover</code> on the server to look for new ones.</p>`;
  }
  const totalForStatus = props.totals[props.status];
  const pagination = renderPagination({
    page: props.page,
    pageSize: props.pageSize,
    total: totalForStatus,
    baseUrl: `/admin/queue?status=${props.status}&sort=${props.sort}&dir=${props.dir}`,
  });

  // Accepted tab: render the shared listing component (same format as
  // search / category pages) instead of the queue-style table. Links go to
  // /r/<full_name> because these repos are in our catalogue.
  if (props.status === 'accepted' && props.listingRows && props.listingRows.length > 0) {
    return `
      <h2>Discovery queue</h2>
      ${tabs}
      ${flash}
      ${renderLeaderTable(props.listingRows, {
        secondaryLabel: 'Stars Δ 30d',
        formatSecondary: (r) => fmtInt(r.star_delta_30d),
      })}
      ${pagination}`;
  }
  const nowMs = Date.now();
  const rows = props.pending
    .map((it) => {
      const safeUrl = escapeHtml(it.url);
      const safeFullName = escapeHtml(urlToFullName(it.url));
      const safeNotes = it.notes ? escapeHtml(it.notes) : '';
      const safeDesc = it.description ? escapeHtml(it.description) : '';
      const starsCell = it.stars === null ? '—' : fmtInt(it.stars);
      const pushedCell = fmtPushedAgo(it.pushed_at, nowMs);
      // Only render the related block when there's actually something to
      // show — the "first repo we've seen from this owner" empty state
      // wasn't telling the admin anything they couldn't tell from the
      // absence itself, and at 200-row queue density it became noise.
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
          : '';
      // Accept/Reject buttons only make sense on pending rows — accepted /
      // rejected rows are already decided; surfacing the buttons would let
      // the admin "re-accept" a row that no longer corresponds to a queue
      // action (decideQueueItem would no-op or churn).
      const actions =
        props.status === 'pending'
          ? `<form action="/admin/queue/decide" method="post" style="display:inline">
               <input type="hidden" name="url" value="${safeUrl}">
               <input type="hidden" name="decision" value="accept">
               <button type="submit">Accept</button>
             </form>
             <form action="/admin/queue/decide" method="post" style="display:inline">
               <input type="hidden" name="url" value="${safeUrl}">
               <input type="hidden" name="decision" value="reject">
               <button type="submit">Reject</button>
             </form>`
          : `<span class="muted small">${escapeHtml(it.status)}</span>`;
      // For accepted rows the repo is in our catalogue (auto-approve inserted
      // it into `repos`), so we link to the internal detail page — same as
      // any listing page. Pending/rejected rows aren't in `repos` (or
      // shouldn't be navigated to internally), so they keep the GitHub link.
      const repoLink =
        props.status === 'accepted'
          ? `<a href="/r/${safeFullName}">${safeFullName}</a>`
          : `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeFullName}</a>`;
      return `<tr>
        <td>
          ${repoLink}
          ${safeDesc ? `<div class="muted small">${safeDesc}</div>` : ''}
          ${related}
        </td>
        <td class="num">${starsCell}</td>
        <td class="num small">${escapeHtml(pushedCell)}</td>
        <td class="num small">${escapeHtml(it.discovered_at.slice(0, 10))}</td>
        <td class="muted small">${safeNotes}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join('');
  // Sortable column headers — clicking toggles direction when re-clicked
  // on the active sort, otherwise picks the column's natural default
  // (stars/desc, pushed/desc — both "best first").
  const sortHeader = (
    col: 'discovered' | 'stars' | 'pushed',
    label: string,
    align: 'num' | '' = '',
  ) => {
    const isActive = props.sort === col;
    const nextDir = isActive && props.dir === 'desc' ? 'asc' : 'desc';
    const arrow = isActive ? (props.dir === 'desc' ? ' ▼' : ' ▲') : '';
    // Sort change resets to page 1 — paging on a sort the user just
    // toggled mid-stream is more confusing than starting over.
    const href = `/admin/queue?status=${props.status}&sort=${col}&dir=${nextDir}&page=1`;
    const cls = `${align}${isActive ? ' sort-active' : ''}`.trim();
    return `<th class="${cls}"><a href="${href}">${escapeHtml(label)}${arrow}</a></th>`;
  };
  return `
    <h2>Discovery queue</h2>
    ${tabs}
    ${flash}
    <table>
      <thead><tr>
        <th>Repo</th>
        ${sortHeader('stars', 'Stars', 'num')}
        ${sortHeader('pushed', 'Last push', 'num')}
        ${sortHeader('discovered', 'Discovered', 'num')}
        <th>Notes</th>
        <th>Action</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${pagination}`;
}
