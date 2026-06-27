-- 0010: 'suppressed' flag for platform / non-module repos.
--
-- hacs/integration is the HACS platform itself, not a HACS module a user
-- would install via HACS — but it has a hacs.json at the root, so our
-- discovery pipeline auto-approved it. Showing it in leaderboards is
-- confusing ("HACS itself, downloads 100k" sits next to "ha-bleep,
-- downloads 23"). Suppressed rows are hidden from every listing, search,
-- category, and stats query — they remain in `repos` so re-discovery
-- doesn't re-add them, but they don't pollute the public surface.
ALTER TABLE repos ADD COLUMN suppressed INTEGER NOT NULL DEFAULT 0;

-- Initial deny-list. Add to this in future migrations rather than at
-- runtime so the rationale is captured in version control.
UPDATE repos SET suppressed = 1 WHERE full_name IN ('hacs/integration');
