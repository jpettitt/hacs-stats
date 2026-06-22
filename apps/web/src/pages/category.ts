import { type RowForList, fmtInt, kindLabel, renderLeaderTable } from '../components.js';
import { escapeHtml } from '../sanitize.js';

export interface CategoryPageProps {
  kind: string;
  rows: RowForList[];
}

export interface CategoriesIndexProps {
  totals: Array<{ kind: string; n: number }>;
}

export function renderCategoryPage(props: CategoryPageProps): string {
  const label = kindLabel(props.kind);
  if (props.rows.length === 0) {
    return `<h2>${label}</h2><p class="muted">No repos in this category yet.</p>`;
  }
  return `
    <h2>${label} <span class="muted small">(${props.rows.length} shown)</span></h2>
    ${renderLeaderTable(props.rows, {
      valueLabel: 'Stars',
      formatValue: (r) => fmtInt(r.stars),
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
