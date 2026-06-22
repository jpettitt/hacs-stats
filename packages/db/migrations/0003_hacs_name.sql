-- 0003_hacs_name.sql — store the `name` field from hacs.json alongside the
-- canonical filename. Used by the UI to render `Mushroom (piitaya/lovelace-mushroom)`
-- rather than the raw owner/repo for every reference.
--
-- Backfill happens on the next scrape: the orchestrator's "needs manifest"
-- filter also matches repos with NULL hacs_name, so we'll repopulate
-- progressively without a separate migration step.

ALTER TABLE repos ADD COLUMN hacs_name TEXT;
