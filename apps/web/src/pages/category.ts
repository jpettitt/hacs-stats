import { fmtInt, kindLabel } from '../components.js';
import { escapeHtml } from '../sanitize.js';

export interface CategoriesIndexProps {
  totals: Array<{ kind: string; n: number }>;
}

export function renderCategoriesIndex(props: CategoriesIndexProps): string {
  // Cards link straight to the search page with the kind preset. There's
  // no separate /category renderer anymore (it 302s here too) — one
  // listing surface, one URL shape.
  const cards = props.totals
    .map(
      (t) =>
        `<a class="card" href="/search?kind=${escapeHtml(t.kind)}&sort=stars">
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
