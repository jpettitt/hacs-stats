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
}

const LEADER_SELECT = `
  SELECT
    r.id, r.full_name, r.hacs_name, r.kind, r.source, r.description, r.archived, r.is_fork,
    r.first_seen_at,
    COALESCE(latest.stars, 0)                         AS stars,
    latest.last_commit_at,
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

export function topByStars(db: Db, limit = 20): LeaderRow[] {
  return db.raw
    .prepare<[number], LeaderRow>(`${LEADER_SELECT} ORDER BY stars DESC LIMIT ?`)
    .all(limit);
}

export function topByDownloads30d(db: Db, limit = 20): LeaderRow[] {
  return db.raw
    .prepare<[number], LeaderRow>(
      `${LEADER_SELECT} ORDER BY downloads_30d DESC, stars DESC LIMIT ?`,
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
      `${LEADER_SELECT} ORDER BY latest_release_downloads DESC, stars DESC LIMIT ?`,
    )
    .all(limit);
}

export function trendingByStars(db: Db, limit = 20): LeaderRow[] {
  return db.raw
    .prepare<[number], LeaderRow>(
      `${LEADER_SELECT}
        WHERE COALESCE(sc.star_delta_7d, 0) > 0
        ORDER BY star_delta_7d DESC, stars DESC
        LIMIT ?`,
    )
    .all(limit);
}

/**
 * Recently added to the HACS default lists — first_seen_at is set when our
 * scraper first sees a repo. On day 1 every repo has the same value, so this
 * is most useful on day 2+.
 */
export function newArrivals(db: Db, limit = 20): LeaderRow[] {
  return db.raw
    .prepare<[number], LeaderRow>(
      `${LEADER_SELECT} ORDER BY r.first_seen_at DESC, r.id DESC LIMIT ?`,
    )
    .all(limit);
}

/**
 * Recently active upstream — last_commit_at comes from the default-branch
 * HEAD commit date via GraphQL.
 */
export function recentlyUpdated(db: Db, limit = 20): LeaderRow[] {
  return db.raw
    .prepare<[number], LeaderRow>(
      `${LEADER_SELECT}
        WHERE latest.last_commit_at IS NOT NULL
        ORDER BY latest.last_commit_at DESC
        LIMIT ?`,
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
      `${LEADER_SELECT} WHERE r.kind = ? ORDER BY stars DESC LIMIT ? OFFSET ?`,
    )
    .all(kind, limit, offset);
  const total =
    db.raw
      .prepare<[RepoKind], { n: number }>('SELECT COUNT(*) AS n FROM repos WHERE kind = ?')
      .get(kind)?.n ?? 0;
  return { rows, total };
}

export const SEARCH_SORTS = ['name', 'stars', 'downloads', 'trending', 'recent'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export const SEARCH_SORT_LABELS: Record<SearchSort, string> = {
  name: 'Name (A-Z)',
  stars: 'Stars (high to low)',
  downloads: 'Downloads (latest release)',
  trending: 'Trending (30d downloads delta)',
  recent: 'Recently active',
};

// ORDER BY clauses are NEVER interpolated from user input directly — the
// `sort` parameter is validated against SEARCH_SORTS by the caller, and we
// look the SQL up by key here. Same shape for kind further down.
const ORDER_BY_BY_SORT: Record<SearchSort, string> = {
  // SQLite treats "" as an identifier; the empty string literal is ''.
  name: "COALESCE(NULLIF(r.hacs_name, ''), r.full_name) COLLATE NOCASE ASC",
  stars: 'stars DESC, r.full_name COLLATE NOCASE ASC',
  downloads: 'latest_release_downloads DESC, stars DESC, r.full_name COLLATE NOCASE ASC',
  // trending uses the new clean 30d-delta on the latest release, NOT the
  // legacy SUM-across-releases column which double-counts upgrades.
  trending: 'latest_release_downloads_30d DESC, stars DESC, r.full_name COLLATE NOCASE ASC',
  recent: 'latest.last_commit_at DESC, r.full_name COLLATE NOCASE ASC',
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

  const wheres: string[] = [];
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
  const whereClause = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';

  // Cheap COUNT(*) — uses the same WHERE but no joins. ~5ms on 3.3k rows.
  const total =
    db.raw
      .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM repos r ${whereClause}`)
      .get(...params)?.n ?? 0;

  const pageParams = [...params, limit, offset];
  const sql = `${LEADER_SELECT} ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const rows = db.raw.prepare<unknown[], LeaderRow>(sql).all(...pageParams);

  return { rows, total };
}

export interface RepoDetail extends LeaderRow {
  hacs_filename: string | null;
  default_branch: string | null;
  owner: string;
  name: string;
  last_scraped_at: string | null;
}

export function repoDetailByFullName(db: Db, fullName: string): RepoDetail | undefined {
  return db.raw
    .prepare<[string], RepoDetail>(
      `${LEADER_SELECT.replace(
        'r.id, r.full_name, r.hacs_name, r.kind, r.source, r.description, r.archived, r.is_fork,',
        'r.id, r.full_name, r.hacs_name, r.kind, r.source, r.description, r.archived, r.is_fork, r.owner, r.name, r.hacs_filename, r.default_branch, r.last_scraped_at,',
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
  published_at: string;
  is_prerelease: number;
  html_url: string;
  downloads: number;
}

export function releaseDownloadsForRepo(db: Db, repoId: number, limit = 30): ReleaseDownloadRow[] {
  // Attribution: MAX over eligible assets. When hacs_filename is set, only
  // the matching asset is eligible (it's the file HACS actually fetches);
  // otherwise every asset is eligible and MAX picks the dominant one as
  // the install proxy. Mirrors the rollup query in apps/scraper/src/rollup.ts.
  return db.raw
    .prepare<[number, number], ReleaseDownloadRow>(
      `WITH latest_date AS (
        SELECT MAX(snapshot_date) AS d FROM release_asset_snapshots
      ),
      hacs_filter AS (
        SELECT hacs_filename FROM repos WHERE id = ?
      )
      SELECT
        rel.tag, rel.published_at, rel.is_prerelease, rel.html_url,
        COALESCE(MAX(
          CASE
            WHEN (SELECT hacs_filename FROM hacs_filter) IS NULL
              OR ras.asset_name = (SELECT hacs_filename FROM hacs_filter)
              THEN ras.download_count
          END
        ), 0) AS downloads
      FROM releases rel
      LEFT JOIN release_asset_snapshots ras
        ON ras.release_id = rel.id AND ras.snapshot_date = (SELECT d FROM latest_date)
      WHERE rel.repo_id = ?
      GROUP BY rel.id
      ORDER BY rel.published_at DESC
      LIMIT 30`,
    )
    .all(repoId, repoId)
    .slice(0, limit);
}
