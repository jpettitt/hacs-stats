import { fmtDelta, fmtInt, kindLabel } from '../components.js';
import { escapeHtml, safeGithubRepoUrl } from '../sanitize.js';
import { renderLineChart } from '../svg-chart.js';

export interface RepoDetailProps {
  full_name: string;
  hacs_name: string | null;
  kind: string;
  description: string | null;
  archived: number;
  hacs_filename: string | null;
  default_branch: string | null;
  first_seen_at: string;
  last_commit_at: string | null;
  last_scraped_at: string | null;
  stars: number;
  star_delta_7d: number;
  star_delta_30d: number;
  downloads_30d: number;
  top_version_30d: string | null;
  latest_release_tag: string | null;
  latest_release_downloads: number;
}

export interface RepoDetailViewModel {
  detail: RepoDetailProps;
  starsSeries: Array<{ date: string; value: number }>;
  releases: Array<{
    tag: string;
    published_at: string;
    is_prerelease: number;
    html_url: string;
    downloads: number;
  }>;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return escapeHtml(iso.slice(0, 10));
}

export function renderRepoDetail(vm: RepoDetailViewModel): string {
  const { detail, starsSeries, releases } = vm;
  const ghUrl = safeGithubRepoUrl(detail.full_name);

  // Title: prefer the hacs.json name (escaped); always show owner/repo as a
  // muted secondary line for unambiguous identification + GitHub link.
  const safeFull = escapeHtml(detail.full_name);
  const safeName = detail.hacs_name ? escapeHtml(detail.hacs_name) : null;
  const titleHeading = safeName ?? safeFull;
  const subtitle = safeName
    ? `<p class="muted small subtitle">${ghUrl ? `<a href="${ghUrl}" target="_blank" rel="noopener noreferrer">${safeFull} ↗</a>` : safeFull}</p>`
    : ghUrl
      ? `<p class="muted small subtitle"><a href="${ghUrl}" target="_blank" rel="noopener noreferrer">View on GitHub ↗</a></p>`
      : '';

  const archivedBadge = detail.archived ? ' <span class="badge badge-muted">archived</span>' : '';

  const description = detail.description
    ? `<p class="lead">${escapeHtml(detail.description)}</p>`
    : '<p class="lead muted">No description provided.</p>';

  const statTile = (value: string, label: string) =>
    `<div class="stat-tile"><strong>${escapeHtml(value)}</strong><span class="muted small">${escapeHtml(label)}</span></div>`;

  // Headline number: cumulative downloads of the LATEST non-prerelease
  // release's HACS asset. Closer to "current install base" than a 30-day
  // delta. We expose the 30d delta too, smaller, as a trend signal.
  const downloadsLabel = detail.latest_release_tag
    ? `downloads of ${detail.latest_release_tag}`
    : 'downloads (latest release)';
  const statsGrid = `
    <div class="stat stats-row">
      ${statTile(fmtInt(detail.stars), 'stars')}
      ${statTile(fmtDelta(detail.star_delta_7d), 'stars Δ 7d')}
      ${statTile(fmtDelta(detail.star_delta_30d), 'stars Δ 30d')}
      ${statTile(fmtInt(detail.latest_release_downloads), downloadsLabel)}
      ${statTile(fmtInt(detail.downloads_30d), 'downloads Δ 30d')}
    </div>`;

  const topVersion = '';

  const starsChart = renderLineChart(starsSeries, {
    ariaLabel: `Stars over time for ${detail.full_name}`,
  });

  const releaseRows = releases
    .map((r) => {
      // html_url is from GitHub; we trust it but still escape for attribute context.
      // Internal repo URLs go through safeGithubRepoUrl; release URLs we let
      // through because they're constrained to https://github.com/owner/repo/...
      // when the owner/repo passed the strict allow-list. We escape as a belt.
      const safeHtmlUrl = escapeHtml(r.html_url);
      return `<tr>
        <td><a href="${safeHtmlUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.tag)}</a>${r.is_prerelease ? ' <span class="muted small">pre</span>' : ''}</td>
        <td>${fmtDate(r.published_at)}</td>
        <td class="num">${escapeHtml(fmtInt(r.downloads))}</td>
      </tr>`;
    })
    .join('');

  const releasesTable = releases.length
    ? `<table>
        <thead><tr><th>Tag</th><th>Published</th><th class="num">Downloads (latest snapshot)</th></tr></thead>
        <tbody>${releaseRows}</tbody>
      </table>`
    : '<p class="muted">No releases recorded yet.</p>';

  const hacsFilename = detail.hacs_filename
    ? `<code>${escapeHtml(detail.hacs_filename)}</code>`
    : '<span class="muted">(none declared; counts sum all release assets)</span>';

  const metaTable = `
    <table>
      <tbody>
        <tr><td>Kind</td><td>${kindLabel(detail.kind)}</td></tr>
        <tr><td>HACS asset</td><td>${hacsFilename}</td></tr>
        <tr><td>Default branch</td><td>${escapeHtml(detail.default_branch ?? '—')}</td></tr>
        <tr><td>Last upstream commit</td><td>${fmtDate(detail.last_commit_at)}</td></tr>
        <tr><td>First seen by us</td><td>${fmtDate(detail.first_seen_at)}</td></tr>
        <tr><td>Last scraped</td><td>${fmtDate(detail.last_scraped_at)}</td></tr>
      </tbody>
    </table>`;

  return `
    <h2 class="repo-title">${titleHeading}${archivedBadge}</h2>
    ${subtitle}
    ${description}
    ${statsGrid}
    ${topVersion}
    <section>
      <h2>Stars over time</h2>
      ${starsChart}
      ${starsSeries.length < 2 ? '<p class="muted small">Chart needs at least 2 daily snapshots to draw a line. Once tomorrow’s scrape lands, the trend will show up here.</p>' : ''}
    </section>
    <section>
      <h2>Metadata</h2>
      ${metaTable}
    </section>
    <section>
      <h2>Recent releases</h2>
      ${releasesTable}
    </section>`;
}
