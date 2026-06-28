import {
  type RowForList,
  fmtDelta,
  fmtDownloads,
  fmtInt,
  kindLabel,
  renderLeaderTable,
  renderPagination,
} from '../components.js';
import { escapeHtml } from '../sanitize.js';

/** Available sort keys for the search UI — same set the DB layer accepts. */
export const SORT_OPTIONS = [
  { value: 'name', label: 'Name (A-Z)' },
  { value: 'stars', label: 'Stars (high to low)' },
  { value: 'downloads', label: 'Downloads (latest release)' },
  { value: 'trending', label: 'Trending (stars Δ 30d)' },
  { value: 'recent', label: 'Recent releases' },
  { value: 'new', label: 'New arrivals' },
] as const;

export type SortValue = (typeof SORT_OPTIONS)[number]['value'];

export interface SearchPageProps {
  query: string;
  sort: SortValue;
  /** undefined = "all categories". */
  kind: string | undefined;
  /** All allowed kinds, for the dropdown. */
  allKinds: string[];
  hits: RowForList[];
  page: number;
  pageSize: number;
  total: number;
}

function dropdown(
  name: string,
  selected: string | undefined,
  options: Array<{ value: string; label: string }>,
): string {
  return `<select name="${name}">${options
    .map(
      (o) =>
        `<option value="${escapeHtml(o.value)}"${o.value === selected ? ' selected' : ''}>${escapeHtml(o.label)}</option>`,
    )
    .join('')}</select>`;
}

/**
 * Map a sort key to the cell that should appear immediately left of the
 * always-rightmost Stars column. The spec:
 *   - sort by name / stars / trending → secondary is Stars Δ 30d
 *     (we'd just be re-showing the same number otherwise; Δ tells you why
 *      it moved up the list).
 *   - sort by downloads → secondary is Downloads.
 *   - sort by recent → secondary is Last commit.
 *   - sort by new → secondary is First seen.
 */
function secondaryValueForSort(r: RowForList, sort: SortValue): string {
  switch (sort) {
    case 'downloads':
      // Version on its own line so digits align in the column (matches
      // the home "Top by downloads" treatment).
      return `${escapeHtml(fmtDownloads(r.latest_release_downloads ?? 0))}${
        r.latest_release_tag
          ? `<br><span class="muted small">${escapeHtml(r.latest_release_tag)}</span>`
          : ''
      }`;
    case 'recent':
      return r.latest_release_at ? escapeHtml(r.latest_release_at.slice(0, 10)) : '—';
    case 'new':
      return escapeHtml((r.first_seen_at ?? '').slice(0, 10));
    default:
      // name / stars / trending all use Stars Δ 30d as the secondary —
      // signed delta so + / - is meaningful.
      return escapeHtml(fmtDelta(r.star_delta_30d));
  }
}

function secondaryLabelForSort(sort: SortValue): string {
  switch (sort) {
    case 'downloads':
      return 'Downloads';
    case 'recent':
      return 'Last release';
    case 'new':
      return 'First seen';
    default:
      return 'Stars Δ 30d';
  }
}

/** Long-form label for the sort dropdown / summary text ("sorted by X"). */
function labelForSort(sort: SortValue): string {
  return SORT_OPTIONS.find((o) => o.value === sort)?.label ?? 'Stars';
}

export function renderSearchPage(props: SearchPageProps): string {
  const q = escapeHtml(props.query);
  const kindOptions = [
    { value: '', label: 'All categories' },
    ...props.allKinds.map((k) => ({ value: k, label: kindLabel(k).replace(/<\/?[^>]+>/g, '') })),
  ];

  // The filter bar is its own <form> so changing sort/kind submits without
  // making the user re-type the query. action="/search" keeps the URL
  // bookmarkable.
  const filterBar = `
    <form class="filter-bar" action="/search" method="get" role="search">
      <label class="visually-hidden" for="q">Query</label>
      <input id="q" type="search" name="q" value="${q}" placeholder="Search repos…" autocomplete="off">
      <label class="visually-hidden" for="kind">Category</label>
      ${dropdown('kind', props.kind ?? '', kindOptions).replace('<select', '<select id="kind"')}
      <label class="visually-hidden" for="sort">Sort by</label>
      ${dropdown('sort', props.sort, [...SORT_OPTIONS]).replace('<select', '<select id="sort"')}
      <button type="submit">Apply</button>
    </form>`;

  if (props.hits.length === 0) {
    const msg =
      props.query.length > 0
        ? `No repos match <code>${q}</code>${props.kind ? ` in <code>${escapeHtml(props.kind)}</code>` : ''}.`
        : 'Pick a category or type a query above to see results.';
    return `<h2>Search</h2>${filterBar}<p class="muted" style="margin-top:1rem;">${msg}</p>`;
  }

  const summaryHeader =
    props.query.length > 0
      ? `${props.total} result${props.total === 1 ? '' : 's'} for <code>${q}</code>${props.kind ? ` in <code>${escapeHtml(props.kind)}</code>` : ''}`
      : `${props.total} repos${props.kind ? ` in <code>${escapeHtml(props.kind)}</code>` : ''}, sorted by ${escapeHtml(labelForSort(props.sort).toLowerCase())}`;

  const table = renderLeaderTable(props.hits, {
    secondaryLabel: secondaryLabelForSort(props.sort),
    formatSecondary: (r) => secondaryValueForSort(r as RowForList, props.sort),
  });

  // Build the base URL preserving every filter EXCEPT page (the pagination
  // helper appends it). URLSearchParams gets the encoding right for us.
  const baseParams = new URLSearchParams();
  if (props.query) baseParams.set('q', props.query);
  if (props.kind) baseParams.set('kind', props.kind);
  if (props.sort !== 'name') baseParams.set('sort', props.sort);
  const baseUrl = baseParams.toString() ? `/search?${baseParams.toString()}` : '/search';

  const pagination = renderPagination({
    page: props.page,
    pageSize: props.pageSize,
    total: props.total,
    baseUrl,
  });

  return `
    <h2>Search</h2>
    ${filterBar}
    <p class="muted small" style="margin-top:1rem;">${summaryHeader}</p>
    ${table}
    ${pagination}
  `;
}
