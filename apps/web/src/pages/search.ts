import {
  type RowForList,
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
  { value: 'trending', label: 'Trending (30d Δ)' },
  { value: 'recent', label: 'Recently active' },
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

function valueForSort(r: RowForList, sort: SortValue): string {
  // formatValue returns trusted HTML; caller escapes anything user-derived.
  // For sort='name' the sort key IS the repo name (already in the Repo
  // column), so the value cell shows stars as the consolation metric —
  // see columnHeaderForSort for the matching column label.
  switch (sort) {
    case 'stars':
      return escapeHtml(fmtInt(r.stars));
    case 'downloads':
      // Version on its own line so digits align in the column (matches
      // the home "Top by downloads" treatment).
      return `${escapeHtml(fmtInt(r.latest_release_downloads ?? 0))}${
        r.latest_release_tag
          ? `<br><span class="muted small">${escapeHtml(r.latest_release_tag)}</span>`
          : ''
      }`;
    case 'trending':
      return escapeHtml(fmtInt(r.downloads_30d));
    case 'recent':
      return r.last_commit_at ? escapeHtml(r.last_commit_at.slice(0, 10)) : '—';
    default:
      return escapeHtml(fmtInt(r.stars));
  }
}

/** Column header — must match what valueForSort actually puts in the cell.
 * Not the same as the sort-dropdown label; the dropdown describes the SORT,
 * this describes the column's CONTENT. (Previously they were the same and
 * we ended up showing "399" under a "Name (A-Z)" header.) */
function columnHeaderForSort(sort: SortValue): string {
  switch (sort) {
    case 'downloads':
      return 'Downloads';
    case 'trending':
      return 'New in 30d';
    case 'recent':
      return 'Last commit';
    default:
      return 'Stars';
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
    valueLabel: columnHeaderForSort(props.sort),
    formatValue: (r) => valueForSort(r as RowForList, props.sort),
    // Hide the stars-delta column when sorting by stars — it'd be the same
    // column twice — but show it elsewhere so users see the trend.
    showStarDelta: props.sort !== 'stars',
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
