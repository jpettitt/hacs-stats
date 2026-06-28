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
  /** default | discovered | submitted — shown as a small badge in listings. */
  source?: string;
  /** pending | active | offline | removed — lifecycle state from repos.state.
   * Default listings filter to 'active'; this surfaces on /pending, /removed,
   * and the detail page when navigated to directly. */
  state?: string;
  /** GitHub fork flag — surfaced as a "fork" badge alongside source. */
  is_fork?: number;
  archived?: number;
  /** Mostly redundant with state — kept as a fallback for callers that
   * didn't select `state`. */
  last_scraped_at?: string | null;
  stars: number;
  latest_release_downloads?: number;
  latest_release_tag?: string | null;
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

/**
 * Display formatter for the downloads column. Renders '—' for zero so
 * the row doesn't read as "this repo has zero installs" when really we
 * have no install signal at all — HACS integrations that install from
 * source clone have no GitHub release assets to count, and GitHub
 * doesn't expose source-tarball download counts. The underlying value
 * is still 0, so DB-level sorts put these rows at the bottom of
 * "by downloads" naturally.
 */
export function fmtDownloads(n: number): string {
  return n === 0 ? '—' : fmtInt(n);
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

const KIND_TIP: Record<string, string> = {
  integration:
    'Home Assistant integration — adds a new device type / service. Installs into custom_components.',
  plugin: 'Lovelace plugin (custom card or row). Loaded as a JS resource by the frontend.',
  theme: 'Lovelace theme — colours, fonts, dashboard styling.',
  appdaemon: 'AppDaemon app — Python automation that runs alongside Home Assistant.',
  netdaemon: 'NetDaemon app — C# automation that runs alongside Home Assistant.',
  python_script: 'Python script — small server-side script callable from automations.',
  template: 'Jinja template macro / helper.',
};

/** Inline category badge — replaces the standalone Kind column in
 * listings so the row stays narrow on phones. Same hover/tap tooltip
 * pattern as repoTags(). */
export function kindBadge(kind: string): string {
  const label = KIND_LABEL[kind] ?? kind;
  const tip = KIND_TIP[kind] ?? `HACS category: ${label}`;
  return ` <span class="tag tag-kind" tabindex="0" data-tip="${escapeHtml(tip)}">${escapeHtml(label)}</span>`;
}

/**
 * Small inline badges describing where a repo came from + whether it's a
 * fork or archived. Returns "" for the common case (HACS-default, not a
 * fork, not archived) so listings don't get cluttered.
 */
/** Time in ms used for the "unmaintained" badge cutoff. Repos older than
 * STALE_AFTER_MS are filtered from listings entirely (see leaders.ts);
 * repos older than UNMAINTAINED_AFTER_MS but younger than STALE_AFTER_MS
 * get a warning badge. Both thresholds intentionally live in code rather
 * than config — they're product judgment, not knobs. */
const UNMAINTAINED_AFTER_MS = 365 * 24 * 60 * 60 * 1000;

export function repoTags(row: {
  source?: string;
  is_fork?: number;
  archived?: number;
  last_scraped_at?: string | null;
  last_commit_at?: string | null;
}): string {
  const tags: string[] = [];
  // Pending tag comes first so it's the most prominent — it's the most
  // important piece of context ("the numbers next to this aren't real yet").
  // Only show when explicitly null (column was selected and the value
  // really is missing); undefined means the caller didn't ask for it, so
  // we can't tell — stay silent.
  // Lifecycle state tags come first when non-default (most important context).
  // `state` is the canonical signal; `last_scraped_at IS NULL` is mostly a
  // proxy for pending and only used as a fallback when state isn't selected.
  const state = (row as { state?: string }).state;
  // Each badge is a focusable span — tabindex=0 makes it keyboard-
  // reachable AND lets a tap on mobile trigger :focus, which the CSS uses
  // to surface the tooltip (`title=...` alone is invisible on touch).
  const tip = (cls: string, label: string, text: string) =>
    `<span class="tag ${cls}" tabindex="0" data-tip="${escapeHtml(text)}">${label}</span>`;
  if (state === 'pending' || (state === undefined && row.last_scraped_at === null)) {
    tags.push(
      tip(
        'tag-pending',
        'pending',
        'Accepted but not yet scraped — stars / downloads appear after the next nightly run.',
      ),
    );
  } else if (state === 'offline') {
    tags.push(
      tip(
        'tag-offline',
        'offline',
        'Recent scrapes have not been able to reach this repo on GitHub. Numbers below are the last known good values.',
      ),
    );
  } else if (state === 'removed') {
    tags.push(
      tip(
        'tag-removed',
        'removed',
        'Unreachable for 30+ days — likely deleted or made private on GitHub.',
      ),
    );
  }
  if (row.source === 'default') {
    tags.push(
      tip(
        'tag-hacs',
        'HACS',
        'Listed in the official HACS default catalogue (github.com/hacs/default). Installs by name in HACS without adding a custom repository.',
      ),
    );
  } else if (row.source === 'discovered') {
    tags.push(
      tip(
        'tag-discovered',
        'discovered',
        'Found by our GitHub code-search for hacs.json. Not in the official HACS list — installable as a HACS custom repository.',
      ),
    );
  } else if (row.source === 'submitted') {
    tags.push(
      tip(
        'tag-submitted',
        'submitted',
        'Added via the public /submit form. Not in the official HACS list — installable as a HACS custom repository.',
      ),
    );
  }
  if (row.is_fork)
    tags.push(
      tip('tag-fork', 'fork', 'Fork of another GitHub repo. Stats reflect this fork only.'),
    );
  if (row.archived)
    tags.push(
      tip(
        'tag-archived',
        'archived',
        'Marked archived on GitHub — read-only; no longer maintained.',
      ),
    );
  // Unmaintained: last default-branch commit between 1 year and the
  // stale-3y cutoff (the 3y cutoff hides the row entirely upstream — we
  // never see those here). Heads-up for users so they don't install
  // something the author has clearly walked away from.
  if (row.last_commit_at) {
    const t = Date.parse(row.last_commit_at);
    if (Number.isFinite(t) && Date.now() - t > UNMAINTAINED_AFTER_MS) {
      const ageYears = (Date.now() - t) / (365 * 24 * 60 * 60 * 1000);
      tags.push(
        tip(
          'tag-unmaintained',
          'unmaintained',
          `No commits on the default branch in ${ageYears.toFixed(1)} years. Still listed (we hide repos with no activity in 3+ years entirely), but consider whether the author is around to fix bugs.`,
        ),
      );
    }
  }
  return tags.length ? ` ${tags.join(' ')}` : '';
}

export interface LeaderTableOptions {
  /** Column header for the secondary cell (the one immediately to the left
   * of the always-rightmost Stars column). */
  secondaryLabel: string;
  /**
   * Format the secondary cell. Returns trusted HTML — callers are
   * responsible for escaping any untrusted strings they interpolate. This
   * lets the caller compose richer cells (e.g. "12,345 (v3.5.0)" with the
   * tag in muted text); the alternative — auto-escape — meant any HTML
   * the caller wanted to inline got rendered as text.
   */
  formatSecondary: (r: RowForList) => string;
  /** Show the description column. Default true. Disable for compact tables. */
  showDescription?: boolean;
}

/** Truncate long descriptions for compact display in tables. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Render Prev / Next + "Page X of Y, N results" navigation.
 *
 * `baseUrl` should already include any non-page query params (q, sort, kind,
 * etc.) — the renderer appends `&page=N` or `?page=N` as appropriate.
 * Hides the bar entirely when the result set fits on one page.
 */
export interface PaginationProps {
  page: number; // 1-based
  pageSize: number;
  total: number;
  baseUrl: string; // e.g. "/search?q=foo&sort=stars"
}

export function renderPagination(p: PaginationProps): string {
  const lastPage = Math.max(1, Math.ceil(p.total / p.pageSize));
  if (lastPage <= 1) {
    return `<p class="muted small page-info">${p.total} result${p.total === 1 ? '' : 's'}.</p>`;
  }
  const sep = p.baseUrl.includes('?') ? '&' : '?';
  const link = (n: number, label: string, current: boolean) => {
    if (current) return `<span class="page-current">${escapeHtml(label)}</span>`;
    const href = `${escapeHtml(p.baseUrl)}${sep}page=${n}`;
    return `<a class="page-link" href="${href}">${escapeHtml(label)}</a>`;
  };
  const prev =
    p.page > 1 ? link(p.page - 1, '← Prev', false) : `<span class="page-disabled">← Prev</span>`;
  const next =
    p.page < lastPage
      ? link(p.page + 1, 'Next →', false)
      : `<span class="page-disabled">Next →</span>`;
  const start = (p.page - 1) * p.pageSize + 1;
  const end = Math.min(p.total, p.page * p.pageSize);
  return `<nav class="pagination" role="navigation" aria-label="Pagination">
    ${prev}
    <span class="page-info muted small">Showing ${start}–${end} of ${p.total} — page ${p.page} of ${lastPage}</span>
    ${next}
  </nav>`;
}

/**
 * Listing-table layout (single source of truth across home + search +
 * accepted-queue tab):
 *
 *   Repo | (Description) | Kind | <secondary> | Stars
 *
 * Stars is ALWAYS the rightmost column so the user's eye lands in a
 * consistent place. The cell to its left is the "secondary" — typically
 * whatever the page sorted by. When the sort IS stars (or name, where
 * stars is the natural ranking signal), the secondary becomes Stars
 * Δ 30d so we're not showing two identical numbers next to each other.
 *
 * Callers used to pass `valueLabel` + `formatValue` + `showStarDelta` —
 * the new shape collapses those into one secondary slot. `showStarDelta`
 * is gone; the secondary is whatever the caller decides.
 */
export function renderLeaderTable(rows: RowForList[], opts: LeaderTableOptions): string {
  const showDesc = opts.showDescription ?? true;
  const head = `<tr>
    <th>Repo</th>
    ${showDesc ? '<th class="desc-col">Description</th>' : ''}
    <th class="num">${escapeHtml(opts.secondaryLabel)}</th>
    <th class="num">Stars</th>
  </tr>`;
  // Kind moved into the Repo cell as a tag (with hover/tap tooltip) so we
  // can shed a whole column — at phone widths the row was running off-screen.
  const body = rows
    .map(
      (r) => `<tr>
        <td>${repoLink(r.full_name, r.hacs_name)}${kindBadge(r.kind)}${repoTags(r)}</td>
        ${showDesc ? `<td class="desc-col muted small">${r.description ? escapeHtml(clip(r.description, 110)) : ''}</td>` : ''}
        <td class="num">${opts.formatSecondary(r)}</td>
        <td class="num">${escapeHtml(fmtInt(r.stars))}</td>
      </tr>`,
    )
    .join('');
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}
