-- 0007_parent_full_name.sql — for forks, remember what they were forked
-- from. Surfaced on the repo detail page's Metadata table so a user looking
-- at a fork can see the lineage at a glance ("this is a fork of X — was X
-- abandoned, or is this just a contribution branch?").
--
-- NULL for non-forks (the default). Populated by GraphQL via
-- updateRepoMetadata on the next scrape.

ALTER TABLE repos ADD COLUMN parent_full_name TEXT;
