import { type RowForList, fmtInt, kindLabel, renderLeaderTable } from '../components.js';
import { escapeHtml } from '../sanitize.js';

/** Available sort keys for the search UI — same set the DB layer accepts. */
export const SORT_OPTIONS = [
  { value: 'name', label: 'Name (A-Z)' },
  { value: 'stars', label: 'Stars (high to low)' },
  { value: 'downloads_30d', label: 'Downloads 30d' },
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
  switch (sort) {
    case 'stars':
      return fmtInt(r.stars);
    case 'downloads_30d':
      return fmtInt(r.downloads_30d);
    case 'recent':
      return r.last_commit_at ? r.last_commit_at.slice(0, 10) : '—';
    default:
      return fmtInt(r.stars);
  }
}

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

  const summary =
    props.query.length > 0
      ? `${props.hits.length} result${props.hits.length === 1 ? '' : 's'} for <code>${q}</code>${props.kind ? ` in <code>${escapeHtml(props.kind)}</code>` : ''}`
      : `${props.hits.length} repos${props.kind ? ` in <code>${escapeHtml(props.kind)}</code>` : ''}, sorted by ${escapeHtml(labelForSort(props.sort).toLowerCase())}`;

  const table = renderLeaderTable(props.hits, {
    valueLabel: labelForSort(props.sort),
    formatValue: (r) => valueForSort(r as RowForList, props.sort),
    // Hide the stars-delta column when sorting by stars — it'd be the same
    // column twice — but show it elsewhere so users see the trend.
    showStarDelta: props.sort !== 'stars',
  });

  return `
    <h2>Search</h2>
    ${filterBar}
    <p class="muted small" style="margin-top:1rem;">${summary}</p>
    ${table}
  `;
}
