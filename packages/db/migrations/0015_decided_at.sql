-- 0015: track when a discovery_queue row was accepted/rejected so the
-- catalogue-wide Last-Modified header reflects admin activity (not just
-- the scrape / discover daily timestamps). Without this, a /pending
-- view stays cached at the edge until the next nightly scrape advances
-- the catalogue date — slow feedback after an admin clears the queue.
--
-- Nullable, set by setQueueStatus at decision time. Existing rows
-- (decided before this migration) stay NULL; the cache-key fallback
-- to the catalogue date keeps working for them.
ALTER TABLE discovery_queue ADD COLUMN decided_at TEXT;
