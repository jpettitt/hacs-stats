-- 0009: enrich discovery_queue with stars / pushed_at / description so the
-- admin queue UI can show + sort by them without a per-page-render GitHub
-- fetch. Populated by scripts/discover.ts at enqueue time (one extra REST
-- call per surviving candidate — already happening when autoApprove is on,
-- now unconditional). Pre-migration rows have NULL for all three; the UI
-- renders "—" and sorts them last.
ALTER TABLE discovery_queue ADD COLUMN stars INTEGER;
ALTER TABLE discovery_queue ADD COLUMN pushed_at TEXT;
ALTER TABLE discovery_queue ADD COLUMN description TEXT;
