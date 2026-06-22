/**
 * YYYY-MM-DD in UTC. We snapshot on UTC dates so a scraper that crosses
 * midnight half-way through the run doesn't end up writing two different
 * dates for the same logical scrape — pin "today" once at the start of the
 * run and pass it through.
 *
 * Tests can pass a `now` to get deterministic strings.
 */
export function todayUtcIsoDate(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
