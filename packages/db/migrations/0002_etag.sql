-- 0002_etag.sql — cache the `Link`-paginated /releases ETag per repo so daily
-- runs can short-circuit on 304 Not Modified. Saves ~3k API calls per run
-- for repos that didn't ship a release in the last 24h (most of them).

ALTER TABLE repos ADD COLUMN releases_etag TEXT;
