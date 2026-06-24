import { type RowForList, fmtInt, kindLabel, renderLeaderTable, repoLink } from '../components.js';
import { escapeHtml } from '../sanitize.js';

export type LeaderRow = RowForList;

export interface HomeProps {
  repoCount: number;
  topByStars: LeaderRow[];
  topByDownloads: LeaderRow[];
  trendingByStars: LeaderRow[];
  newArrivals: LeaderRow[];
  recentlyUpdated: LeaderRow[];
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return escapeHtml(iso.slice(0, 10));
}

function descCell(d: string | null | undefined, max = 90): string {
  if (!d) return '<td class="desc-col muted small"></td>';
  const trimmed = d.length > max ? `${d.slice(0, max - 1).trimEnd()}…` : d;
  return `<td class="desc-col muted small">${escapeHtml(trimmed)}</td>`;
}

export function renderHome(props: HomeProps): string {
  const { repoCount, topByStars, topByDownloads, trendingByStars, newArrivals, recentlyUpdated } =
    props;

  const trendingNote =
    trendingByStars.length === 0
      ? '<p class="muted small">No 7-day star deltas yet. After two daily scrapes, repos that picked up new stars will appear here.</p>'
      : '';

  return `
    <p class="lead">Public download &amp; star stats for the Home Assistant Community Store.</p>

    <div class="stat">Tracking <strong>${escapeHtml(fmtInt(repoCount))}</strong> repositories across the HACS catalogue.</div>

    <section>
      <h2>Top by stars</h2>
      ${renderLeaderTable(topByStars, {
        valueLabel: 'Stars',
        formatValue: (r) => escapeHtml(fmtInt(r.stars)),
        showStarDelta: false,
      })}
    </section>

    <section>
      <h2>Top by downloads</h2>
      <p class="lead small">
        Cumulative downloads of the HACS-asset on each repo's latest stable
        release — closest proxy we have for current install base. Prereleases
        are excluded so a 0.0.0-rc upload doesn't displace the real number.
      </p>
      ${renderLeaderTable(topByDownloads, {
        valueLabel: 'Downloads',
        formatValue: (r) =>
          `${fmtInt(r.latest_release_downloads ?? 0)}${r.latest_release_tag ? ` <span class="muted small">(${escapeHtml(r.latest_release_tag)})</span>` : ''}`,
      })}
    </section>

    <section>
      <h2>Trending (7-day star delta)</h2>
      ${trendingNote}
      ${renderLeaderTable(trendingByStars, {
        valueLabel: 'Stars Δ 7d',
        formatValue: (r) => escapeHtml(`+${fmtInt(r.star_delta_30d)}`),
        showStarDelta: false,
      })}
    </section>

    <section>
      <h2>Recently active</h2>
      <p class="lead small">Most recent commit on the default branch.</p>
      <table>
        <thead><tr><th>Repo</th><th class="desc-col">Description</th><th>Kind</th><th class="num">Last commit</th><th class="num">Stars</th></tr></thead>
        <tbody>${recentlyUpdated
          .map(
            (r) => `<tr>
              <td>${repoLink(r.full_name, r.hacs_name)}</td>
              ${descCell(r.description)}
              <td class="kind">${kindLabel(r.kind)}</td>
              <td class="num small">${fmtDate(r.last_commit_at)}</td>
              <td class="num">${escapeHtml(fmtInt(r.stars))}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>
    </section>

    <section>
      <h2>New arrivals</h2>
      <p class="lead small">Recently added to the HACS default lists.</p>
      <table>
        <thead><tr><th>Repo</th><th class="desc-col">Description</th><th>Kind</th><th class="num">First seen</th></tr></thead>
        <tbody>${newArrivals
          .map(
            (r) => `<tr>
              <td>${repoLink(r.full_name, r.hacs_name)}</td>
              ${descCell(r.description)}
              <td class="kind">${kindLabel(r.kind)}</td>
              <td class="num small">${fmtDate(r.first_seen_at)}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>
    </section>
  `;
}
