export interface RepoSnapshot {
  repo_id: number;
  snapshot_date: string;
  stars: number;
  forks: number;
  open_issues: number;
  last_commit_at: string | null;
}

export interface Release {
  id: number;
  repo_id: number;
  tag: string;
  published_at: string;
  is_prerelease: number;
  html_url: string;
}

export interface ReleaseAssetSnapshot {
  release_id: number;
  asset_name: string;
  snapshot_date: string;
  download_count: number;
}

export interface StatsCacheRow {
  repo_id: number;
  top_version_30d: string | null;
  top_version_downloads_30d: number | null;
  total_downloads_30d: number | null;
  star_delta_7d: number | null;
  star_delta_30d: number | null;
  updated_at: string;
}
