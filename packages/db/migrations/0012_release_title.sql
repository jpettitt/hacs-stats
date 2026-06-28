-- 0012: store release name + body so the UI can display a human-readable
-- title alongside the tag (e.g. "Initial public release" rather than
-- just "v0.1.0"). Both columns are nullable — populated by the scraper
-- on the next /releases fetch for each repo. Existing rows stay NULL
-- until a release in that repo changes (ETag invalidation) and we
-- re-fetch the page. Acceptable: tag-only display still works.
ALTER TABLE releases ADD COLUMN name TEXT;
ALTER TABLE releases ADD COLUMN body TEXT;
