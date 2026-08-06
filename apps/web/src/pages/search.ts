import {
  type RowForList,
  fmtDelta,
  fmtDownloads,
  fmtInt,
  kindLabel,
  renderLeaderTable,
  renderPagination,
} from '../components.js';
import { type HtmlValue, type SafeHtml, html } from '../safe-html.js';

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
  id: string,
  name: string,
  selected: string | undefined,
  options: Array<{ value: string; label: string }>,
): SafeHtml {
  return html`<select id="${id}" name="${name}">${options.map(
    (o) =>
      html`<option value="${o.value}"${o.value === selected ? html` selected` : ''}>${o.label}</option>`,
  )}</select>`;
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
function secondaryValueForSort(r: RowForList, sort: SortValue): HtmlValue {
  switch (sort) {
    case 'downloads':
      // Version on its own line so digits align in the column (matches
      // the home "Top by downloads" treatment).
      return html`${fmtDownloads(r.latest_release_downloads ?? 0)}${
        r.latest_release_tag
          ? html`<br><span class="muted small">${r.latest_release_tag}</span>`
          : ''
      }`;
    case 'recent':
      return r.latest_release_at ? r.latest_release_at.slice(0, 10) : '—';
    case 'new':
      return (r.first_seen_at ?? '').slice(0, 10);
    default:
      // name / stars / trending all use Stars Δ 30d as the secondary —
      // signed delta so + / - is meaningful.
      return fmtDelta(r.star_delta_30d);
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

export function renderSearchPage(props: SearchPageProps): SafeHtml {
  const kindOptions = [
    { value: '', label: 'All categories' },
    ...props.allKinds.map((k) => ({ value: k, label: kindLabel(k) })),
  ];

  // The filter bar is its own <form> so changing sort/kind submits without
  // making the user re-type the query. action="/search" keeps the URL
  // bookmarkable.
  const filterBar = html`
    <form class="filter-bar" action="/search" method="get" role="search">
      <label class="visually-hidden" for="q">Query</label>
      <input id="q" type="search" name="q" value="${props.query}" placeholder="Search repos…" autocomplete="off">
      <label class="visually-hidden" for="kind">Category</label>
      ${dropdown('kind', 'kind', props.kind ?? '', kindOptions)}
      <label class="visually-hidden" for="sort">Sort by</label>
      ${dropdown('sort', 'sort', props.sort, [...SORT_OPTIONS])}
      <button type="submit">Apply</button>
    </form>`;

  if (props.hits.length === 0) {
    const msg =
      props.query.length > 0
        ? html`No repos match <code>${props.query}</code>${props.kind ? html` in <code>${props.kind}</code>` : ''}.`
        : html`Pick a category or type a query above to see results.`;
    return html`<h2>Search</h2>${filterBar}<p class="muted" style="margin-top:1rem;">${msg}</p>`;
  }

  const summaryHeader =
    props.query.length > 0
      ? html`${props.total} result${props.total === 1 ? '' : 's'} for <code>${props.query}</code>${props.kind ? html` in <code>${props.kind}</code>` : ''}`
      : html`${props.total} repos${props.kind ? html` in <code>${props.kind}</code>` : ''}, sorted by ${labelForSort(props.sort).toLowerCase()}`;

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

  return html`
    <h2>Search</h2>
    ${filterBar}
    <p class="muted small" style="margin-top:1rem;">${summaryHeader}</p>
    ${table}
    ${pagination}
  `;
}
