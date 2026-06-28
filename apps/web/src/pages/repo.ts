import { fmtDelta, fmtDownloads, fmtInt, kindLabel, repoTags } from '../components.js';
import { escapeHtml, isSafeRepoFullName, safeGithubRepoUrl } from '../sanitize.js';
import { renderLineChart } from '../svg-chart.js';

export interface RepoDetailProps {
  full_name: string;
  hacs_name: string | null;
  kind: string;
  source: string;
  state: string;
  first_failure_at: string | null;
  is_fork: number;
  parent_full_name: string | null;
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
  /** LEGACY 30d delta; not surfaced anymore. */
  downloads_30d: number;
  top_version_30d: string | null;
  latest_release_tag: string | null;
  latest_release_downloads: number;
  /** Clean install signal: latest release's downloads in the last 30 days. */
  latest_release_downloads_30d: number;
  /** Release with the highest 90-day delta (may differ from latest). */
  hot_release_tag_90d: string | null;
  hot_release_downloads_90d: number;
}

export interface RepoDetailViewModel {
  detail: RepoDetailProps;
  starsSeries: {
    points: Array<{ date: string; value: number }>;
    /** True when the 3-year display rule clipped older data. Lets the
     * chart float the y-axis instead of pinning to 0. */
    truncated: boolean;
  };
  releases: Array<{
    tag: string;
    name: string | null;
    body: string | null;
    published_at: string;
    is_prerelease: number;
    html_url: string;
    downloads: number;
    has_asset: number;
  }>;
  /** Other repos in the catalogue owned by the same GitHub owner. Empty
   * when this is the only one (the page renders a sibling-count line, no
   * full section). */
  relatedRepos: Array<{ full_name: string; hacs_name: string | null; kind: string }>;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return escapeHtml(iso.slice(0, 10));
}

/**
 * Derive a human-readable release title:
 *   1. GitHub release "name" field if the author set one.
 *   2. First `# Heading` line from the body if present.
 *   3. First 60 chars of the body (whitespace-collapsed).
 *   4. Empty string — caller shows only the tag.
 *
 * Returns plain text (the caller escapes for HTML context).
 */
function deriveReleaseTitle(name: string | null, body: string | null): string {
  if (name && name.trim().length > 0) return name.trim();
  if (!body) return '';
  // Look for the FIRST line beginning with # (one or more). Skips blank
  // lines and other text above it — common when the body starts with a
  // header. Capped at 80 chars so a stuffed-into-the-title sentence
  // doesn't blow out the column.
  const headingMatch = body.match(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/m);
  if (headingMatch?.[1]) return headingMatch[1].trim().slice(0, 80);
  // No heading — take the first 60 chars of the collapsed body.
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return '';
  return collapsed.length > 60 ? `${collapsed.slice(0, 59).trimEnd()}…` : collapsed;
}

export function renderRepoDetail(vm: RepoDetailViewModel): string {
  const { detail, starsSeries, releases, relatedRepos } = vm;
  const owner = detail.full_name.split('/')[0] ?? '';
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

  // Source / fork / archived tags. archivedBadge stays variable-named for
  // diff continuity but actually emits the full set via repoTags().
  const archivedBadge = repoTags({
    source: detail.source,
    is_fork: detail.is_fork,
    archived: detail.archived,
  });

  const description = detail.description
    ? `<p class="lead">${escapeHtml(detail.description)}</p>`
    : '<p class="lead muted">No description provided.</p>';

  const statTile = (value: string, label: string) =>
    `<div class="stat-tile"><strong>${escapeHtml(value)}</strong><span class="muted small">${escapeHtml(label)}</span></div>`;

  // Headline number: cumulative downloads of the LATEST non-prerelease
  // release's HACS asset. Closer to "current install base" than any delta.
  // We expose the clean 30d delta (latest release's own growth) as a
  // second tile — NOT the legacy SUM-across-releases, which double-counted
  // upgrades.
  // Lifecycle banner: makes the page's "this is non-default state" context
  // unmissable when the user has navigated to a pending/offline/removed
  // repo (they got here on purpose — via /pending, /removed, or a link).
  let lifecycleBanner = '';
  if (detail.state === 'pending') {
    lifecycleBanner = `
      <div class="banner banner-info">
        <strong>Pending scrape.</strong>
        <span>We've accepted this repo into the catalogue but the next nightly
        scrape will fill in stars / downloads / release history. Numbers below
        may be empty until then.</span>
      </div>`;
  } else if (detail.state === 'offline') {
    const since = detail.first_failure_at
      ? ` since ${escapeHtml(detail.first_failure_at.slice(0, 10))}`
      : '';
    lifecycleBanner = `
      <div class="banner banner-warn">
        <strong>Offline${since}.</strong>
        <span>Recent scrapes haven't been able to reach this repo. It may have
        been moved, made private, or deleted on GitHub. Numbers below are the
        last known good values; after 30 days of failures it will move to the
        removed list.</span>
      </div>`;
  } else if (detail.state === 'removed') {
    lifecycleBanner = `
      <div class="banner banner-err">
        <strong>Removed.</strong>
        <span>This repo has been unreachable for 30+ days. Data is historical;
        nothing here is being refreshed.</span>
      </div>`;
  }

  // The page is rendered the same way for all repos — pending/offline/removed
  // get a banner above (see lifecycle banners below) but the stat tiles
  // always show whatever data we have. The state machine hides pending
  // repos from default listings; if you reached this page, you wanted to
  // see what's known about it.
  const downloadsLabel = detail.latest_release_tag
    ? `downloads of ${detail.latest_release_tag}`
    : 'downloads (latest release)';
  // "Source install" detection — repo has releases but NONE of them have
  // a tracked asset. HACS clones the repo source for these (typical for
  // integrations and plugins with content_in_root: true), and GitHub
  // doesn't expose source-tarball download counts. So we have nothing
  // to count; surface the reason rather than leaving em-dashes
  // unexplained.
  const isSourceInstall = releases.length > 0 && releases.every((r) => r.has_asset === 0);
  const sourceInstallNote = isSourceInstall
    ? `<p class="lead small subtitle muted">
        <strong>Source-install package.</strong> No release asset is
        attached — HACS installs by cloning the repo. GitHub doesn't
        expose source-tarball download counts, so we have no install-
        count metric to show. Star and release activity below are the
        signals available.
      </p>`
    : '';
  const statsGrid = `
    <div class="stat stats-row">
      ${statTile(fmtInt(detail.stars), 'stars')}
      ${statTile(fmtDelta(detail.star_delta_7d), 'stars Δ 7d')}
      ${statTile(fmtDelta(detail.star_delta_30d), 'stars Δ 30d')}
      ${
        isSourceInstall
          ? ''
          : `${statTile(fmtDownloads(detail.latest_release_downloads), downloadsLabel)}
             ${statTile(fmtDownloads(detail.latest_release_downloads_30d), 'new in last 30d')}`
      }
    </div>
    ${sourceInstallNote}`;

  // Surfaces the release with the highest 90-day delta on its dominant
  // asset — useful when the most-pulled version isn't the latest tag.
  const hotVersion =
    detail.hot_release_tag_90d && detail.hot_release_downloads_90d > 0
      ? `<p class="lead small subtitle">
          Most-downloaded release in the last 90 days:
          <code>${escapeHtml(detail.hot_release_tag_90d)}</code>
          (${escapeHtml(fmtInt(detail.hot_release_downloads_90d))} downloads)${
            detail.hot_release_tag_90d !== detail.latest_release_tag
              ? ' — note this is NOT the latest tag.'
              : ''
          }
        </p>`
      : '';

  const starsChart = renderLineChart(starsSeries.points, {
    ariaLabel: `Stars over time for ${detail.full_name}`,
    // When the 3-year display rule clipped older data, the y-axis floor
    // would otherwise compress the visible portion against the top of
    // the chart. Float the floor in that case; otherwise pin to 0.
    zeroBase: !starsSeries.truncated,
  });

  // Hide the downloads column entirely when NO release in this list has
  // a tracked asset — install-from-source repos (most HACS integrations)
  // have no assets attached to their releases and a column of em-dashes
  // is just noise.
  const anyDownloads = releases.some((r) => r.has_asset === 1);
  const releaseRows = releases
    .map((r) => {
      // html_url is from GitHub; we trust it but still escape for attribute context.
      // Internal repo URLs go through safeGithubRepoUrl; release URLs we let
      // through because they're constrained to https://github.com/owner/repo/...
      // when the owner/repo passed the strict allow-list. We escape as a belt.
      const safeHtmlUrl = escapeHtml(r.html_url);
      const title = deriveReleaseTitle(r.name, r.body);
      const titleCell = title ? `<div class="muted small">${escapeHtml(title)}</div>` : '';
      const downloadCell = anyDownloads
        ? `<td class="num">${escapeHtml(r.has_asset === 1 ? fmtInt(r.downloads) : '—')}</td>`
        : '';
      return `<tr>
        <td>
          <a href="${safeHtmlUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.tag)}</a>${r.is_prerelease ? ' <span class="muted small">pre</span>' : ''}
          ${titleCell}
        </td>
        <td>${fmtDate(r.published_at)}</td>
        ${downloadCell}
      </tr>`;
    })
    .join('');

  const releasesTable = releases.length
    ? `<table>
        <thead><tr><th>Release</th><th>Published</th>${anyDownloads ? '<th class="num">Downloads (latest snapshot)</th>' : ''}</tr></thead>
        <tbody>${releaseRows}</tbody>
      </table>`
    : '<p class="muted">No releases recorded yet.</p>';

  // "HACS filename" is what hacs.json DECLARES, which isn't the same as
  // what's attached to GitHub releases. When the repo has releases but
  // none of them carry this file as an asset, HACS installs by cloning
  // the source (typical for integrations and plenty of plugins with
  // content_in_root: true). Annotate so the row doesn't read as "this
  // is the file we're counting downloads for".
  const anyReleaseHasAsset = releases.some((r) => r.has_asset === 1);
  const hacsFilename = detail.hacs_filename
    ? `<code>${escapeHtml(detail.hacs_filename)}</code>${
        releases.length > 0 && !anyReleaseHasAsset
          ? ' <span class="muted small">— declared in hacs.json but not attached to releases; HACS installs from source</span>'
          : ''
      }`
    : '<span class="muted">(none declared; we use the most-downloaded asset per release as the install proxy)</span>';

  // For forks, surface what they were forked from so the user can chase
  // the lineage. Link goes to the parent's GitHub page (we don't necessarily
  // have it in our own catalogue). The parent_full_name string came from
  // GitHub's API — route it through safeGithubRepoUrl so a malformed value
  // (or one with /? or #) can't construct a misleading github.com link.
  const parentUrl = detail.parent_full_name ? safeGithubRepoUrl(detail.parent_full_name) : null;
  const forkParentRow = detail.is_fork
    ? `<tr><td>Forked from</td><td>${
        parentUrl && detail.parent_full_name
          ? `<a href="${parentUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(detail.parent_full_name)} ↗</a>`
          : '<span class="muted">unknown (GitHub didn’t return a parent)</span>'
      }</td></tr>`
    : '';

  const metaTable = `
    <table>
      <tbody>
        <tr><td>Kind</td><td>${kindLabel(detail.kind)}</td></tr>
        ${forkParentRow}
        <tr><td>HACS filename</td><td>${hacsFilename}</td></tr>
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
    ${lifecycleBanner}
    ${statsGrid}
    ${hotVersion}
    <section>
      <h2>Stars over time</h2>
      ${starsChart}
      ${starsSeries.points.length < 2 ? '<p class="muted small">Chart needs at least 2 daily snapshots to draw a line. Once tomorrow’s scrape lands, the trend will show up here.</p>' : ''}
    </section>
    <section>
      <h2>Metadata</h2>
      ${metaTable}
    </section>
    <section>
      <h2>Recent releases</h2>
      ${releasesTable}
    </section>
    ${renderRelatedSection(owner, relatedRepos)}`;
}

/**
 * Lists other repos by the same owner so visitors can browse a prolific
 * author's catalogue (e.g. PiotrMachowski, thomasloven). Shown unconditionally
 * — even when empty — because the "only one we've seen from this owner" state
 * is itself useful signal. Links to /owner/<name> for the full owner page.
 */
function renderRelatedSection(
  owner: string,
  related: Array<{ full_name: string; hacs_name: string | null; kind: string }>,
): string {
  if (!owner) return '';
  const safeOwner = escapeHtml(owner);
  if (related.length === 0) {
    return `
      <section>
        <h2>Other repos from <a href="/owner/${safeOwner}">${safeOwner}</a></h2>
        <p class="muted">This is the only repo we've catalogued from this owner.</p>
      </section>`;
  }
  const items = related
    .slice(0, 20)
    .map((r) => {
      const safe = escapeHtml(r.full_name);
      const label = r.hacs_name ? escapeHtml(r.hacs_name) : safe;
      // Guard the /r/<full_name> path with the same shape check the route
      // handler applies — DB-trusted but the assertion is free.
      const linked = isSafeRepoFullName(r.full_name)
        ? `<a href="/r/${safe}">${label}</a>`
        : `<span>${label}</span>`;
      return `<li>${linked} <span class="muted small">${escapeHtml(r.kind)}</span></li>`;
    })
    .join('');
  const more =
    related.length > 20
      ? `<p class="muted small">… and ${related.length - 20} more — see <a href="/owner/${safeOwner}">/owner/${safeOwner}</a>.</p>`
      : '';
  return `
    <section>
      <h2>Other repos from <a href="/owner/${safeOwner}">${safeOwner}</a> (${related.length})</h2>
      <ul class="related-list">${items}</ul>
      ${more}
    </section>`;
}
