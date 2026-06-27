import { type RowForList, fmtInt, kindLabel, repoLink, repoTags } from '../components.js';
import { escapeHtml } from '../sanitize.js';

interface LifecycleRow extends RowForList {
  first_failure_at?: string | null;
  state?: string;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return escapeHtml(iso.slice(0, 10));
}

export interface PendingPageProps {
  rows: LifecycleRow[];
}

/**
 * /pending lists every repo with state='pending' — accepted into the
 * catalogue but never successfully scraped. Useful right after a batch of
 * admin accepts so the user can see what's in the queue for the next run.
 * The submitter can also bookmark this to see when their submission lands.
 */
export function renderPendingPage(props: PendingPageProps): string {
  if (props.rows.length === 0) {
    return `
      <h2>Pending repos</h2>
      <p class="muted">Nothing pending. Accepted submissions and discovered
        repos sit here until the daily scrape fills in their data —
        usually a few hours.</p>
    `;
  }
  const rows = props.rows
    .map(
      (r) => `<tr>
        <td>${repoLink(r.full_name, r.hacs_name)}${repoTags(r)}</td>
        <td class="kind">${kindLabel(r.kind)}</td>
        <td class="num small">${fmtDate(r.first_seen_at)}</td>
      </tr>`,
    )
    .join('');
  return `
    <h2>Pending repos <span class="muted small">(${props.rows.length})</span></h2>
    <p class="lead">
      Accepted into the catalogue but not yet scraped. Stars / downloads /
      release history land after the next nightly run.
    </p>
    <table>
      <thead><tr><th>Repo</th><th>Kind</th><th class="num">Submitted</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

export interface RemovedPageProps {
  rows: LifecycleRow[];
}

/**
 * /removed surfaces repos that were active but have been unreachable for
 * 30+ days. Historical data is kept (so reviewing a dead plugin's old
 * download numbers still works); they just don't show in default listings.
 */
export function renderRemovedPage(props: RemovedPageProps): string {
  if (props.rows.length === 0) {
    return `
      <h2>Removed repos</h2>
      <p class="muted">Nothing removed yet. Repos land here after 30 days of
        consecutive scrape failures (404 / private / deleted).</p>
    `;
  }
  const rows = props.rows
    .map(
      (r) => `<tr>
        <td>${repoLink(r.full_name, r.hacs_name)}${repoTags(r)}</td>
        <td class="kind">${kindLabel(r.kind)}</td>
        <td class="num">${escapeHtml(fmtInt(r.stars))}</td>
        <td class="num small">${fmtDate(r.first_failure_at)}</td>
      </tr>`,
    )
    .join('');
  return `
    <h2>Removed repos <span class="muted small">(${props.rows.length})</span></h2>
    <p class="lead">
      Unreachable for 30+ days. Last-known data preserved; nothing here is
      being refreshed. A recovery (the repo coming back online) flips them
      back to active automatically on the next scrape.
    </p>
    <table>
      <thead><tr><th>Repo</th><th>Kind</th><th class="num">Last stars</th><th class="num">Offline since</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
