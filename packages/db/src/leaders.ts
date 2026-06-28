import type { RepoKind } from '@hacs-stats/shared';
import type { Db } from './client.js';

/**
 * Joined view returned by every leaderboard query. Captures everything the
 * web pages need from a single round trip — full_name + kind for identity
 * and link, latest stars / downloads_30d / star_delta_30d for ranking, the
 * top release tag for "what version are people running."
 */
export interface LeaderRow {
  id: number;
  full_name: string;
  hacs_name: string | null;
  kind: RepoKind;
  /** default | discovered | submitted — see RepoSource. */
  source: string;
  description: string | null;
  archived: number;
  is_fork: number;
  /** ISO string from the last successful scrape, or null if never scraped. */
  last_scraped_at: string | null;
  /** pending | active | offline | removed — lifecycle state. Listings filter
   * to 'active' by default; /pending and /removed surface the others. */
  state: string;
  /** ISO timestamp of first failure in the current failure run (for offline
   * → removed countdown). Null when not in a failure state. */
  first_failure_at: string | null;
  stars: number;
  /** Cumulative downloads on the repo's latest non-prerelease release. */
  latest_release_downloads: number;
  latest_release_tag: string | null;
  /** Clean install signal: change in latest_release_downloads over the last 30d. */
  latest_release_downloads_30d: number;
  /** Tag of the release with the highest 90-day download delta (any release). */
  hot_release_tag_90d: string | null;
  /** That release's 90d download delta. */
  hot_release_downloads_90d: number;
  /** LEGACY: SUM of per-release 30d deltas. Double-counts upgrades. Kept for
   * one release for backwards compat; new UI uses latest_release_downloads_30d. */
  downloads_30d: number;
  star_delta_7d: number;
  star_delta_30d: number;
  top_version_30d: string | null;
  first_seen_at: string;
  last_commit_at: string | null;
  /** Most-recent release published_at (any release, prereleases included).
   * Populated only by queries that JOIN releases — undefined otherwise.
   * Surfaced on the home "Recent releases" section. */
  latest_release_at?: string | null;
}

const LEADER_SELECT = `
  SELECT
    r.id, r.full_name, r.hacs_name, r.kind, r.source, r.description, r.archived, r.is_fork,
    r.first_seen_at, r.last_scraped_at, r.state, r.first_failure_at,
    COALESCE(latest.stars, 0)                         AS stars,
    latest.last_commit_at,
    -- Correlated subquery (not a grouped JOIN): SQLite pushes the
    -- r.id predicate in and uses idx_releases_repo_published for an
    -- index-only MAX. With a JOIN-grouped subquery instead, the
    -- aggregation ran over the whole releases table per outer
    -- query — fine for full leaderboards, catastrophic for the
    -- single-repo detail page (2-3s on 40k+ release rows).
    (SELECT MAX(published_at) FROM releases WHERE repo_id = r.id) AS latest_release_at,
    COALESCE(sc.latest_release_downloads, 0)          AS latest_release_downloads,
    sc.latest_release_tag,
    COALESCE(sc.latest_release_downloads_30d, 0)      AS latest_release_downloads_30d,
    sc.hot_release_tag_90d,
    COALESCE(sc.hot_release_downloads_90d, 0)         AS hot_release_downloads_90d,
    COALESCE(sc.total_downloads_30d, 0)               AS downloads_30d,
    COALESCE(sc.star_delta_7d, 0)                     AS star_delta_7d,
    COALESCE(sc.star_delta_30d, 0)                    AS star_delta_30d,
    sc.top_version_30d
  FROM repos r
  LEFT JOIN stats_cache sc ON sc.repo_id = r.id
  LEFT JOIN (
    SELECT repo_id, stars, last_commit_at
    FROM repo_snapshots
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM repo_snapshots)
  ) latest ON latest.repo_id = r.id
`;

// All default leaderboard queries filter to state='active' and
// suppressed=0. Suppressed rows are platform / meta repos that aren't
// HACS modules in the user-installable sense (e.g. hacs/integration
// itself) — kept in the catalogue so re-discovery doesn't re-add them,
// but hidden from every public surface.
//
// Stale-3y rule: repos with no default-branch commit in 3+ years are
// hidden from every listing even if HACS still lists them as default.
// The data is kept (so /pending/removed pages can still surface them
// and we don't lose history) but they're treated as abandoned for
// listing purposes. last_commit_at IS NULL means "we don't know yet"
// (e.g. a freshly auto-approved row before the first scrape) — keep
// those visible until we have a real signal.
const STALE_CUTOFF = "date('now', '-3 years')";
const ACTIVE_ONLY = `r.state = 'active' AND r.suppressed = 0
  AND (latest.last_commit_at IS NULL OR latest.last_commit_at > ${STALE_CUTOFF})`;

export function topByStars(db: Db, limit = 20): LeaderRow[] {
  return db.raw
    .prepare<[number], LeaderRow>(
      `${LEADER_SELECT} WHERE ${ACTIVE_ONLY} ORDER BY stars DESC LIMIT ?`,
    )
    .all(limit);
}

export function topByDownloads30d(db: Db, limit = 20): LeaderRow[] {
  return db.raw
    .prepare<[number], LeaderRow>(
      `${LEADER_SELECT} WHERE ${ACTIVE_ONLY} ORDER BY downloads_30d DESC, stars DESC LIMIT ?`,
    )
    .all(limit);
}

/**
 * Top repos by cumulative downloads on their latest stable release —
 * roughly "current install base". Preferred headline metric over the 30-day
 * delta, which is more about velocity than popularity.
 */
export function topByLatestReleaseDownloads(db: Db, limit = 20): LeaderRow[] {
  return db.raw
    .prepare<[number], LeaderRow>(
      `${LEADER_SELECT} WHERE ${ACTIVE_ONLY} ORDER BY latest_release_downloads DESC, stars DESC LIMIT ?`,
    )
    .all(limit);
}

/** Top by 30-day star delta. Matches the /search?sort=trending ranking
 * exactly so the home "Trending" section's "See all" link lands on the
 * same metric, just paginated. */
export function trendingByStars(db: Db, limit = 20): LeaderRow[] {
  return db.raw
    .prepare<[number], LeaderRow>(
      `${LEADER_SELECT}
        WHERE ${ACTIVE_ONLY} AND COALESCE(sc.star_delta_30d, 0) > 0
        ORDER BY star_delta_30d DESC, stars DESC
        LIMIT ?`,
    )
    .all(limit);
}

/**
 * Recently added — first_seen_at is set when our scraper first sees a repo.
 * Filtered to state='active' so pending submissions don't show until their
 * first successful scrape.
 */
export function newArrivals(db: Db, limit = 20): LeaderRow[] {
  return db.raw
    .prepare<[number], LeaderRow>(
      `${LEADER_SELECT} WHERE ${ACTIVE_ONLY} ORDER BY r.first_seen_at DESC, r.id DESC LIMIT ?`,
    )
    .all(limit);
}

/**
 * Recent releases — repos with the most-recently-published release
 * (prereleases included; "I just shipped a release candidate" counts
 * as activity worth surfacing). Replaced the older "recently active"
 * (default-branch commit time) signal: a fresh commit on main isn't
 * the same as a fresh release, and the surfaced repos felt arbitrary
 * (every dependabot bump qualified). Most-recent release is the
 * cleaner "this project just shipped something" signal.
 */
export function recentlyUpdated(db: Db, limit = 20): LeaderRow[] {
  return db.raw
    .prepare<[number], LeaderRow>(
      `${LEADER_SELECT}
        WHERE ${ACTIVE_ONLY}
          AND EXISTS (SELECT 1 FROM releases WHERE repo_id = r.id)
        ORDER BY latest_release_at DESC
        LIMIT ?`,
    )
    .all(limit);
}

/**
 * Repos awaiting their first successful scrape. Surfaced on /pending so the
 * admin (and submitters) can see what's queued. Most useful right after a
 * batch of accepts via /admin/queue.
 */
/**
 * Every repo (any state) belonging to a single GitHub owner — powers the
 * /owner/:owner page so visitors can see an author's full HACS portfolio at
 * once. Includes pending/offline/removed too: showing only 'active' would
 * hide newly-auto-approved repos that haven't been scraped yet, which is
 * the opposite of what a portfolio page should do.
 */
export function reposByOwner(db: Db, owner: string, limit = 200): LeaderRow[] {
  return db.raw
    .prepare<[string, number], LeaderRow>(
      `${LEADER_SELECT} WHERE r.owner = ? AND r.suppressed = 0 ORDER BY stars DESC, r.full_name LIMIT ?`,
    )
    .all(owner, limit);
}

export function pendingRepos(db: Db, limit = 200): LeaderRow[] {
  return db.raw
    .prepare<[number], LeaderRow>(
      `${LEADER_SELECT} WHERE r.state = 'pending' ORDER BY r.first_seen_at DESC LIMIT ?`,
    )
    .all(limit);
}

/**
 * Repos that were once active but have been unreachable for 30+ days.
 * Surfaced on /removed; default listings never show them.
 */
export function removedRepos(db: Db, limit = 200): LeaderRow[] {
  return db.raw
    .prepare<[number], LeaderRow>(
      `${LEADER_SELECT} WHERE r.state = 'removed' ORDER BY r.first_failure_at DESC LIMIT ?`,
    )
    .all(limit);
}

export interface CategoryPage {
  rows: LeaderRow[];
  total: number;
}

export function topByCategory(db: Db, kind: RepoKind, limit = 50, offset = 0): CategoryPage {
  const rows = db.raw
    .prepare<[RepoKind, number, number], LeaderRow>(
      `${LEADER_SELECT} WHERE r.kind = ? AND r.suppressed = 0 ORDER BY stars DESC LIMIT ? OFFSET ?`,
    )
    .all(kind, limit, offset);
  const total =
    db.raw
      .prepare<[RepoKind], { n: number }>(
        'SELECT COUNT(*) AS n FROM repos WHERE kind = ? AND suppressed = 0',
      )
      .get(kind)?.n ?? 0;
  return { rows, total };
}

export const SEARCH_SORTS = ['name', 'stars', 'downloads', 'trending', 'recent', 'new'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export const SEARCH_SORT_LABELS: Record<SearchSort, string> = {
  name: 'Name (A-Z)',
  stars: 'Stars (high to low)',
  downloads: 'Downloads (latest release)',
  trending: 'Trending (30d downloads delta)',
  recent: 'Recent releases',
  new: 'New arrivals',
};

// ORDER BY clauses are NEVER interpolated from user input directly — the
// `sort` parameter is validated against SEARCH_SORTS by the caller, and we
// look the SQL up by key here. Same shape for kind further down.
const ORDER_BY_BY_SORT: Record<SearchSort, string> = {
  // SQLite treats "" as an identifier; the empty string literal is ''.
  name: "COALESCE(NULLIF(r.hacs_name, ''), r.full_name) COLLATE NOCASE ASC",
  stars: 'stars DESC, r.full_name COLLATE NOCASE ASC',
  downloads: 'latest_release_downloads DESC, stars DESC, r.full_name COLLATE NOCASE ASC',
  // Trending = star delta over the last 30 days. Previously ranked by
  // download delta which was a different metric than the home page's
  // "Trending" section (star delta) — clicking "See all" from there
  // dropped users into a list sorted by something else entirely.
  trending: 'star_delta_30d DESC, stars DESC, r.full_name COLLATE NOCASE ASC',
  // "recent" used to be default-branch last-commit time; switched to
  // most-recent release published_at so dependabot bumps don't
  // dominate and the metric matches the home "Recent releases"
  // section. Repos with no releases sort to the bottom (NULLs last
  // via the explicit NULLS LAST clause SQLite added in 3.30+).
  recent: 'latest_release_at DESC NULLS LAST, r.full_name COLLATE NOCASE ASC',
  new: 'r.first_seen_at DESC, r.id DESC',
};

export interface SearchOptions {
  q: string;
  sort?: SearchSort;
  kind?: RepoKind;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  rows: LeaderRow[];
  /** Total matching rows across all pages — used for "page X of Y". */
  total: number;
}

/**
 * Returns repos matching `q` (LIKE substring against full_name, hacs_name,
 * description), optionally filtered by `kind`, ordered by `sort`.
 *
 * Returns the joined LeaderRow shape so the search page can render the
 * same columns as the home leaderboards (stars, downloads, deltas), plus
 * a `total` count for pagination — the second query reuses the WHERE
 * clause but skips the JOINs to count cheaply.
 *
 * Special "empty q" semantics: when q is blank but kind or sort filters are
 * set, we return every matching row — gives users a way to browse "all
 * plugins by stars" via the search UI. Capped by `limit` + `offset`.
 */
export function searchRepos(db: Db, opts: SearchOptions): SearchResult {
  const sort: SearchSort = opts.sort ?? 'name';
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const escapedQ = opts.q.replace(/[\\%_]/g, (c) => `\\${c}`);
  const needle = `%${escapedQ}%`;
  const hasQ = opts.q.length > 0;
  const orderBy = ORDER_BY_BY_SORT[sort];

  // Always exclude suppressed + stale-3y rows. The stale predicate needs
  // last_commit_at from the latest snapshot — both queries below JOIN to
  // `latest` so the predicate can reference latest.last_commit_at.
  const wheres: string[] = [
    'r.suppressed = 0',
    `(latest.last_commit_at IS NULL OR latest.last_commit_at > ${STALE_CUTOFF})`,
  ];
  const params: unknown[] = [];
  if (hasQ) {
    wheres.push(
      `(r.full_name LIKE ? ESCAPE '\\' OR r.hacs_name LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\')`,
    );
    params.push(needle, needle, needle);
  }
  if (opts.kind !== undefined) {
    wheres.push('r.kind = ?');
    params.push(opts.kind);
  }
  // Sort-specific filter: trending only makes sense for repos that
  // actually moved. Without this, "Trending" is dominated by 7000+
  // repos at delta=0 with the handful of real movers buried below the
  // first page. EXISTS keeps the COUNT(*) query (no JOINs) working.
  if (sort === 'trending') {
    wheres.push(
      'EXISTS (SELECT 1 FROM stats_cache sc WHERE sc.repo_id = r.id AND COALESCE(sc.star_delta_30d, 0) != 0)',
    );
  }
  const whereClause = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';

  // COUNT(*) uses the same WHERE — must JOIN `latest` for the stale-3y
  // predicate. The inner SELECT MAX(snapshot_date) is one row regardless
  // of repo count; the JOIN itself is on indexed (repo_id, snapshot_date).
  const latestJoin = `LEFT JOIN (
      SELECT repo_id, last_commit_at FROM repo_snapshots
      WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM repo_snapshots)
    ) latest ON latest.repo_id = r.id`;
  const total =
    db.raw
      .prepare<unknown[], { n: number }>(
        `SELECT COUNT(*) AS n FROM repos r ${latestJoin} ${whereClause}`,
      )
      .get(...params)?.n ?? 0;

  const pageParams = [...params, limit, offset];
  const sql = `${LEADER_SELECT} ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const rows = db.raw.prepare<unknown[], LeaderRow>(sql).all(...pageParams);

  return { rows, total };
}

export interface RepoDetail extends LeaderRow {
  hacs_filename: string | null;
  default_branch: string | null;
  parent_full_name: string | null;
  owner: string;
  name: string;
}

export function repoDetailByFullName(db: Db, fullName: string): RepoDetail | undefined {
  // RepoDetail already has last_scraped_at via LeaderRow — but we ALSO want
  // owner / name / hacs_filename / default_branch / parent_full_name here.
  return db.raw
    .prepare<[string], RepoDetail>(
      `${LEADER_SELECT.replace(
        'r.id, r.full_name, r.hacs_name, r.kind, r.source, r.description, r.archived, r.is_fork,',
        'r.id, r.full_name, r.hacs_name, r.kind, r.source, r.description, r.archived, r.is_fork, r.owner, r.name, r.hacs_filename, r.default_branch, r.parent_full_name,',
      )} WHERE r.full_name = ?`,
    )
    .get(fullName);
}

/** Daily stars over the last `days` days (inclusive of today). Ascending date. */
export function repoStarsTimeseries(
  db: Db,
  repoId: number,
  days: number,
): Array<{ date: string; stars: number }> {
  return db.raw
    .prepare<[number, string], { date: string; stars: number }>(
      `SELECT snapshot_date AS date, stars
       FROM repo_snapshots
       WHERE repo_id = ?
         AND snapshot_date >= date('now', ? || ' days')
       ORDER BY snapshot_date ASC`,
    )
    .all(repoId, `-${days}`);
}

/**
 * Latest known download_count per release for one repo, on the most recent
 * snapshot_date. Attribution: MAX over eligible assets — filtered to the
 * declared `hacs_filename` when set, all assets otherwise. Mirrors the
 * stats_cache rollup; see apps/scraper/src/rollup.ts for why MAX (not SUM).
 */
export interface ReleaseDownloadRow {
  tag: string;
  /** GitHub release "title" field. Null when the author left it blank
   * (which is most of the time). UI extracts a display title from
   * `body` in that case. */
  name: string | null;
  /** Markdown body. UI uses it to derive a display title when `name`
   * is null. Stored full; the UI does its own excerpting. */
  body: string | null;
  published_at: string;
  is_prerelease: number;
  html_url: string;
  downloads: number;
  /** True when ANY asset snapshot exists for this release. Distinct
   * from `downloads = 0` (which can also mean "asset exists but no
   * one downloaded") — install-from-source repos have NO assets and
   * the UI hides the downloads column entirely for those. */
  has_asset: number;
}

export function releaseDownloadsForRepo(db: Db, repoId: number, limit = 30): ReleaseDownloadRow[] {
  // Correlated subqueries per release rather than a JOIN+GROUP BY: the
  // planner kept picking the secondary date-only index on
  // release_asset_snapshots and scanning today's full snapshot set per
  // release, which on the VPS (a few thousand assets per day across the
  // catalogue) was 60-500ms per page. Each correlated subquery instead
  // hits the PK (release_id, asset_name, snapshot_date) and is O(log N).
  // Limit caps the subquery count at 30 so total work stays bounded.
  return db.raw
    .prepare<[number, number, number], ReleaseDownloadRow>(
      `WITH latest_date AS (
        SELECT MAX(snapshot_date) AS d FROM release_asset_snapshots
      ),
      hacs_filter AS (
        SELECT hacs_filename FROM repos WHERE id = ?
      )
      SELECT
        rel.tag, rel.name, rel.body, rel.published_at, rel.is_prerelease, rel.html_url,
        COALESCE((
          SELECT MAX(
            CASE
              WHEN (SELECT hacs_filename FROM hacs_filter) IS NULL
                OR ras.asset_name = (SELECT hacs_filename FROM hacs_filter)
                THEN ras.download_count
            END
          )
          FROM release_asset_snapshots ras
          WHERE ras.release_id = rel.id
            AND ras.snapshot_date = (SELECT d FROM latest_date)
        ), 0) AS downloads,
        -- has_asset is "did we EVER snapshot any asset for this release",
        -- not "did we snapshot one today". Important when a repo's assets
        -- weren't part of today's scrape — otherwise the per-release row
        -- reads "no asset" and the downloads column hides for repos
        -- that have assets historically.
        EXISTS (
          SELECT 1 FROM release_asset_snapshots ras2 WHERE ras2.release_id = rel.id
        ) AS has_asset
      FROM releases rel
      WHERE rel.repo_id = ?
      ORDER BY rel.published_at DESC
      LIMIT ?`,
    )
    .all(repoId, repoId, limit);
}
