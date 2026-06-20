export const REPO_KINDS = [
  'integration',
  'plugin',
  'theme',
  'appdaemon',
  'python_script',
  'template',
] as const;

export type RepoKind = (typeof REPO_KINDS)[number];

export const REPO_SOURCES = ['default', 'discovered', 'submitted'] as const;
export type RepoSource = (typeof REPO_SOURCES)[number];

export interface Repo {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  kind: RepoKind;
  source: RepoSource;
  hacs_filename: string | null;
  description: string | null;
  archived: number;
  default_branch: string | null;
  first_seen_at: string;
  last_scraped_at: string | null;
}
