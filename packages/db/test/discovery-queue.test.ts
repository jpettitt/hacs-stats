import { describe, expect, it } from 'vitest';
import { discoveryQueue, openDb, runMigrations } from '../src/index.js';

function freshDb() {
  const db = openDb({ path: ':memory:' });
  runMigrations(db);
  return db;
}

function seedQueue(db: ReturnType<typeof freshDb>) {
  discoveryQueue.enqueueDiscovery(db, {
    url: 'https://github.com/alice/solar-card',
    source: 'code_search',
    notes: 'kind=plugin',
    description: 'A solar production card',
    stars: 10,
  });
  discoveryQueue.enqueueDiscovery(db, {
    url: 'https://github.com/bob/thermo-widget',
    source: 'user_submission',
    notes: 'kind=integration',
    description: 'Thermostat helper with 100% coverage',
    stars: 5,
  });
  discoveryQueue.enqueueDiscovery(db, {
    url: 'https://github.com/carol/solar-forecast',
    source: 'code_search',
    notes: 'kind=integration',
    description: null,
    stars: 2,
  });
  discoveryQueue.setQueueStatus(db, 'https://github.com/carol/solar-forecast', 'rejected', 'dupe');
}

describe('queue search', () => {
  it('filters by url substring', () => {
    const db = freshDb();
    seedQueue(db);
    const hits = discoveryQueue.listQueueByStatus(
      db,
      'pending',
      50,
      'discovered',
      'desc',
      0,
      'solar',
    );
    expect(hits.map((h) => h.url)).toEqual(['https://github.com/alice/solar-card']);
  });

  it('matches description and notes too', () => {
    const db = freshDb();
    seedQueue(db);
    const byDesc = discoveryQueue.listQueueByStatus(
      db,
      'pending',
      50,
      'discovered',
      'desc',
      0,
      'thermostat',
    );
    expect(byDesc.map((h) => h.url)).toEqual(['https://github.com/bob/thermo-widget']);
    const byNotes = discoveryQueue.listQueueByStatus(
      db,
      'rejected',
      50,
      'discovered',
      'desc',
      0,
      'dupe',
    );
    expect(byNotes.map((h) => h.url)).toEqual(['https://github.com/carol/solar-forecast']);
  });

  it('treats LIKE wildcards literally', () => {
    const db = freshDb();
    seedQueue(db);
    // Unescaped, "sol%card" would wildcard-match "solar-card" and
    // "thermo_widget" would match "thermo-widget" via `_`.
    expect(
      discoveryQueue.listQueueByStatus(db, 'pending', 50, 'discovered', 'desc', 0, 'sol%card'),
    ).toEqual([]);
    expect(
      discoveryQueue.listQueueByStatus(db, 'pending', 50, 'discovered', 'desc', 0, 'thermo_widget'),
    ).toEqual([]);
    // A literal "%" still matches bob's "100% coverage" description.
    const hits = discoveryQueue.listQueueByStatus(
      db,
      'pending',
      50,
      'discovered',
      'desc',
      0,
      '100%',
    );
    expect(hits.map((h) => h.url)).toEqual(['https://github.com/bob/thermo-widget']);
  });

  it('scopes counts per status while searching', () => {
    const db = freshDb();
    seedQueue(db);
    expect(discoveryQueue.countQueueByStatus(db, 'solar')).toEqual({
      pending: 1,
      accepted: 0,
      rejected: 1,
      error: 0,
    });
    // No filter → full totals.
    expect(discoveryQueue.countQueueByStatus(db)).toEqual({
      pending: 2,
      accepted: 0,
      rejected: 1,
      error: 0,
    });
  });

  it('keeps sort order under a filter', () => {
    const db = freshDb();
    seedQueue(db);
    const hits = discoveryQueue.listQueueByStatus(db, 'pending', 50, 'stars', 'desc', 0, 'github');
    expect(hits.map((h) => h.stars)).toEqual([10, 5]);
  });
});
