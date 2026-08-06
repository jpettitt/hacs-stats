import { fmtInt, kindLabel } from '../components.js';
import { type SafeHtml, html } from '../safe-html.js';

export interface CategoriesIndexProps {
  totals: Array<{ kind: string; n: number }>;
}

export function renderCategoriesIndex(props: CategoriesIndexProps): SafeHtml {
  // Cards link straight to the search page with the kind preset. There's
  // no separate /category renderer anymore (it 302s here too) — one
  // listing surface, one URL shape.
  const cards = props.totals.map(
    (t) =>
      html`<a class="card" href="/search?kind=${t.kind}&sort=stars">
          <strong>${fmtInt(t.n)}</strong>
          <span>${kindLabel(t.kind)}</span>
        </a>`,
  );
  return html`
    <h2>Browse by category</h2>
    <div class="cards-grid">${cards}</div>
  `;
}
