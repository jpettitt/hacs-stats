import { fmtInt, renderLeaderTable, renderPagination } from '../components.js';
import { type SafeHtml, html, joinHtml } from '../safe-html.js';
import { isSafeRepoFullName, safeHttpsGithubUrl } from '../sanitize.js';

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
  /** Search filter over url/description/notes. Empty string = no filter.
   * Applied to the tab counts too, so the tabs show where a searched-for
   * repo ended up. */
  q: string;
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

export function renderAdminPage(props: AdminPageProps): SafeHtml {
  const flash = props.flash ? html`<p class="lead">${props.flash}</p>` : html``;
  // q rides along on every link (tabs, sort headers, pagination) so a
  // search survives navigation until explicitly cleared.
  const qParam = props.q ? `&q=${encodeURIComponent(props.q)}` : '';
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
    const href = `/admin/queue?status=${key}&sort=${props.sort}&dir=${props.dir}${qParam}`;
    return html`<a href="${href}" class="${active ? 'tab tab-active' : 'tab'}">${label} <span class="muted small">(${count})</span></a>`;
  };
  const tabs = html`
    <nav class="tabs">
      ${tab('pending', 'Pending', props.totals.pending)}
      ${tab('accepted', 'Accepted', props.totals.accepted)}
      ${tab('rejected', 'Rejected', props.totals.rejected)}
      ${tab('error', 'Errored', props.totals.error)}
    </nav>`;
  // GET form so the search lands in the URL (shareable, back-button
  // friendly). Hidden inputs carry status/sort/dir; page deliberately
  // resets to 1 — a new search invalidates the old page number.
  // Reuses .filter-bar from the public search page for styling.
  const searchForm = html`
    <form action="/admin/queue" method="get" class="filter-bar">
      <input type="hidden" name="status" value="${props.status}">
      <input type="hidden" name="sort" value="${props.sort}">
      <input type="hidden" name="dir" value="${props.dir}">
      <input type="search" name="q" value="${props.q}" placeholder="Filter by repo, description, or notes" maxlength="100" autocomplete="off">
      <button type="submit">Search</button>
      ${props.q ? html`<a href="/admin/queue?status=${props.status}&sort=${props.sort}&dir=${props.dir}" class="muted small">Clear</a>` : ''}
    </form>`;
  if (props.pending.length === 0) {
    const emptyText = props.q
      ? html`No <strong>${props.status}</strong> rows match “${props.q}”.`
      : html`No <strong>${props.status}</strong> rows.
        Run <code>pnpm discover</code> on the server to look for new ones.`;
    return html`
      <h2>Discovery queue</h2>
      ${tabs}
      ${searchForm}
      ${flash}
      <p class="muted">${emptyText}</p>`;
  }
  const totalForStatus = props.totals[props.status];
  const pagination = renderPagination({
    page: props.page,
    pageSize: props.pageSize,
    total: totalForStatus,
    baseUrl: `/admin/queue?status=${props.status}&sort=${props.sort}&dir=${props.dir}${qParam}`,
  });

  // Accepted tab: render the shared listing component (same format as
  // search / category pages) instead of the queue-style table. Links go to
  // /r/<full_name> because these repos are in our catalogue.
  if (props.status === 'accepted' && props.listingRows && props.listingRows.length > 0) {
    return html`
      <h2>Discovery queue</h2>
      ${tabs}
      ${searchForm}
      ${flash}
      ${renderLeaderTable(props.listingRows, {
        secondaryLabel: 'Stars Δ 30d',
        formatSecondary: (r) => fmtInt(r.star_delta_30d),
      })}
      ${pagination}`;
  }
  const nowMs = Date.now();
  const rows = props.pending.map((it) => {
    // it.url originates from /submit POST or the discover worker. /submit
    // forces the `https://github.com/<owner>/<name>` shape, but the
    // queue table has no DB-level constraint — anything could be here.
    // Validate before using it as an href to block `javascript:` /
    // `data:` schemes and path-traversal to other github.com paths.
    // Interpolation escaping on its own only defeats attribute-quote
    // breakout.
    const safeGhUrl = safeHttpsGithubUrl(it.url);
    const fullName = urlToFullName(it.url);
    const internalLinkSafe = isSafeRepoFullName(fullName);
    const starsCell = it.stars === null ? '—' : fmtInt(it.stars);
    const pushedCell = fmtPushedAgo(it.pushed_at, nowMs);
    // Only render the related block when there's actually something to
    // show — the "first repo we've seen from this owner" empty state
    // wasn't telling the admin anything they couldn't tell from the
    // absence itself, and at 200-row queue density it became noise.
    const related =
      it.related && it.related.length > 0
        ? html`<div class="related muted small">
              <strong>Related projects from same owner</strong> (${it.related.length}):<br>
              ${joinHtml(
                it.related.slice(0, 8).map((r) => {
                  // Guard the internal /r/ path with the same shape check
                  // we apply on the route handler — defence in depth, the
                  // catalogue is high-trust but the assertion is cheap.
                  const label = r.hacs_name && r.hacs_name.length > 0 ? r.hacs_name : r.full_name;
                  return isSafeRepoFullName(r.full_name)
                    ? html`<a href="/r/${r.full_name}">${label}</a>`
                    : html`<span>${label}</span>`;
                }),
                ', ',
              )}${it.related.length > 8 ? html`, +${it.related.length - 8} more` : ''}
            </div>`
        : html``;
    // Accept/Reject buttons only make sense on pending rows — accepted /
    // rejected rows are already decided; surfacing the buttons would let
    // the admin "re-accept" a row that no longer corresponds to a queue
    // action (decideQueueItem would no-op or churn).
    const actions =
      props.status === 'pending'
        ? html`<form action="/admin/queue/decide" method="post" style="display:inline">
               <input type="hidden" name="url" value="${it.url}">
               <input type="hidden" name="decision" value="accept">
               <button type="submit">Accept</button>
             </form>
             <form action="/admin/queue/decide" method="post" style="display:inline">
               <input type="hidden" name="url" value="${it.url}">
               <input type="hidden" name="decision" value="reject">
               <button type="submit">Reject</button>
             </form>`
        : html`<span class="muted small">${it.status}</span>`;
    // For accepted rows the repo is in our catalogue (auto-approve inserted
    // it into `repos`), so we link to the internal detail page — same as
    // any listing page. Pending/rejected rows aren't in `repos` (or
    // shouldn't be navigated to internally), so they keep the GitHub link.
    const repoLink =
      props.status === 'accepted' && internalLinkSafe
        ? html`<a href="/r/${fullName}">${fullName}</a>`
        : safeGhUrl
          ? html`<a href="${safeGhUrl}" target="_blank" rel="noopener noreferrer">${fullName}</a>`
          : html`<span class="muted">${fullName}</span>`;
    return html`<tr>
        <td>
          ${repoLink}
          ${it.description ? html`<div class="muted small">${it.description}</div>` : ''}
          ${related}
        </td>
        <td class="num">${starsCell}</td>
        <td class="num small">${pushedCell}</td>
        <td class="num small">${it.discovered_at.slice(0, 10)}</td>
        <td class="muted small">${it.notes ?? ''}</td>
        <td>${actions}</td>
      </tr>`;
  });
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
    const href = `/admin/queue?status=${props.status}&sort=${col}&dir=${nextDir}&page=1${qParam}`;
    const cls = `${align}${isActive ? ' sort-active' : ''}`.trim();
    return html`<th class="${cls}"><a href="${href}">${label}${arrow}</a></th>`;
  };
  return html`
    <h2>Discovery queue</h2>
    ${tabs}
    ${searchForm}
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
    ${pagination}
    <script src="/static/admin-queue.js" defer></script>`;
}
