import { describe, expect, it } from 'vitest';
import { renderAdminPage } from '../src/pages/admin.js';

const BASE = {
  totals: { pending: 2, accepted: 1, rejected: 0, error: 0 },
  status: 'pending' as const,
  sort: 'discovered' as const,
  dir: 'desc' as const,
  page: 1,
  pageSize: 50,
};

const ITEM = {
  url: 'https://github.com/alice/solar-card',
  source: 'code_search',
  status: 'pending',
  discovered_at: '2026-08-01T00:00:00Z',
  notes: 'kind=plugin',
  stars: 10,
  pushed_at: null,
  description: null,
};

describe('renderAdminPage — queue search', () => {
  it('renders the search form and echoes the query safely', () => {
    const html = renderAdminPage({ ...BASE, pending: [ITEM], q: '"><script>x</script>' });
    expect(html).toContain('name="q"');
    expect(html).not.toContain('<script>x</script>');
  });

  it('carries q through tab, sort, and clear links', () => {
    const html = renderAdminPage({ ...BASE, pending: [ITEM], q: 'solar card' });
    // Tabs and sort headers keep the filter; clear link drops it.
    expect(html).toContain('/admin/queue?status=accepted&sort=discovered&dir=desc&q=solar%20card');
    expect(html).toContain('/admin/queue?status=pending&sort=stars&dir=desc&page=1&q=solar%20card');
    expect(html).toContain('>Clear</a>');
  });

  it('shows a search-aware empty state', () => {
    const html = renderAdminPage({ ...BASE, pending: [], q: 'nothing-matches' });
    expect(html).toContain('match');
    expect(html).toContain('nothing-matches');
    // The "run pnpm discover" hint is for a genuinely empty queue only.
    expect(html).not.toContain('pnpm discover');
  });

  it('omits q from links when not searching', () => {
    const html = renderAdminPage({ ...BASE, pending: [ITEM], q: '' });
    expect(html).not.toContain('&q=');
    expect(html).not.toContain('>Clear</a>');
  });
});
