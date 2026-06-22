import { type RowForList, fmtInt, kindLabel, renderLeaderTable, repoLink } from '../components.js';
import { escapeHtml } from '../sanitize.js';

export type LeaderRow = RowForList;

export interface HomeProps {
  repoCount: number;
  topByStars: LeaderRow[];
  topByDownloads30d: LeaderRow[];
  trendingByStars: LeaderRow[];
  newArrivals: LeaderRow[];
  recentlyUpdated: LeaderRow[];
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return escapeHtml(iso.slice(0, 10));
}

export function renderHome(props: HomeProps): string {
  const {
    repoCount,
    topByStars,
    topByDownloads30d,
    trendingByStars,
    newArrivals,
    recentlyUpdated,
  } = props;

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
        formatValue: (r) => fmtInt(r.stars),
        showStarDelta: false,
      })}
    </section>

    <section>
      <h2>Top by 30-day downloads</h2>
      <p class="lead small">
        Sum of HACS-asset download deltas over the last 30 days. Until two
        daily snapshots have accumulated, values here will be zero.
      </p>
      ${renderLeaderTable(topByDownloads30d, {
        valueLabel: '30d Δ downloads',
        formatValue: (r) => fmtInt(r.downloads_30d),
      })}
    </section>

    <section>
      <h2>Trending (7-day star delta)</h2>
      ${trendingNote}
      ${renderLeaderTable(trendingByStars, {
        valueLabel: 'Stars Δ 7d',
        formatValue: (r) => `+${fmtInt(r.star_delta_30d)}`,
        showStarDelta: false,
      })}
    </section>

    <section>
      <h2>Recently active</h2>
      <p class="lead small">Most recent commit on the default branch.</p>
      <table>
        <thead><tr><th>Repo</th><th>Kind</th><th class="num">Last commit</th><th class="num">Stars</th></tr></thead>
        <tbody>${recentlyUpdated
          .map(
            (r) => `<tr>
              <td>${repoLink(r.full_name)}</td>
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
        <thead><tr><th>Repo</th><th>Kind</th><th class="num">First seen</th></tr></thead>
        <tbody>${newArrivals
          .map(
            (r) => `<tr>
              <td>${repoLink(r.full_name)}</td>
              <td class="kind">${kindLabel(r.kind)}</td>
              <td class="num small">${fmtDate(r.first_seen_at)}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>
    </section>
  `;
}
