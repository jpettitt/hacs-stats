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
  kind: RepoKind;
  description: string | null;
  archived: number;
  stars: number;
  downloads_30d: number;
  star_delta_7d: number;
  star_delta_30d: number;
  top_version_30d: string | null;
  first_seen_at: string;
  last_commit_at: string | null;
}

const LEADER_SELECT = `
  SELECT
    r.id, r.full_name, r.kind, r.description, r.archived,
    r.first_seen_at,
    COALESCE(latest.stars, 0)            AS stars,
    latest.last_commit_at,
    COALESCE(sc.total_downloads_30d, 0)  AS downloads_30d,
    COALESCE(sc.star_delta_7d, 0)        AS star_delta_7d,
    COALESCE(sc.star_delta_30d, 0)       AS star_delta_30d,
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

export function topByCategory(db: Db, kind: RepoKind, limit = 50): LeaderRow[] {
  return db.raw
    .prepare<[RepoKind, number], LeaderRow>(
      `${LEADER_SELECT} WHERE r.kind = ? ORDER BY stars DESC LIMIT ?`,
    )
    .all(kind, limit);
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
        'r.id, r.full_name, r.kind, r.description, r.archived,',
        'r.id, r.full_name, r.kind, r.description, r.archived, r.owner, r.name, r.hacs_filename, r.default_branch, r.last_scraped_at,',
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
 * snapshot_date. If hacs_filename is set we filter to that asset; otherwise
 * we sum every asset on the release (matches stats_cache attribution).
 */
export interface ReleaseDownloadRow {
  tag: string;
  published_at: string;
  is_prerelease: number;
  html_url: string;
  downloads: number;
}

export function releaseDownloadsForRepo(db: Db, repoId: number, limit = 30): ReleaseDownloadRow[] {
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
        SUM(
          CASE
            WHEN (SELECT hacs_filename FROM hacs_filter) IS NOT NULL
              AND ras.asset_name != (SELECT hacs_filename FROM hacs_filter) THEN 0
            ELSE COALESCE(ras.download_count, 0)
          END
        ) AS downloads
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
