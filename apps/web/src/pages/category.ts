import {
  type RowForList,
  fmtInt,
  kindLabel,
  renderLeaderTable,
  renderPagination,
} from '../components.js';
import { escapeHtml } from '../sanitize.js';

export interface CategoryPageProps {
  kind: string;
  rows: RowForList[];
  page: number;
  pageSize: number;
  total: number;
}

export interface CategoriesIndexProps {
  totals: Array<{ kind: string; n: number }>;
}

export function renderCategoryPage(props: CategoryPageProps): string {
  const label = kindLabel(props.kind);
  if (props.total === 0) {
    return `<h2>${label}</h2><p class="muted">No repos in this category yet.</p>`;
  }
  return `
    <h2>${label}</h2>
    <p class="muted small">${props.total} repos in this category, sorted by stars.</p>
    ${renderLeaderTable(props.rows, {
      valueLabel: 'Stars',
      formatValue: (r) => escapeHtml(fmtInt(r.stars)),
    })}
    ${renderPagination({
      page: props.page,
      pageSize: props.pageSize,
      total: props.total,
      baseUrl: `/category/${escapeHtml(props.kind)}`,
    })}
  `;
}

export function renderCategoriesIndex(props: CategoriesIndexProps): string {
  const cards = props.totals
    .map(
      (t) =>
        `<a class="card" href="/category/${escapeHtml(t.kind)}">
          <strong>${escapeHtml(fmtInt(t.n))}</strong>
          <span>${kindLabel(t.kind)}</span>
        </a>`,
    )
    .join('');
  return `
    <h2>Browse by category</h2>
    <div class="cards-grid">${cards}</div>
  `;
}
