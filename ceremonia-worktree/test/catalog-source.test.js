import { describe, expect, it } from 'vitest';
import { buildCatalog, directoryCatalogSource, loadCatalog } from '../src/catalog/index.js';

/**
 * The catalog reads through a CatalogSource. The shipped directory source
 * gives the same bundle loadCatalog caches, and an in-memory source builds
 * and validates a bundle with no files.
 */

function memorySource(files) {
  return {
    read: (name) => {
      if (!(name in files)) throw new Error(`no file ${name}`);
      return structuredClone(files[name]);
    },
    strategyFiles: () => Object.keys(files).filter((name) => name.startsWith('strategies/')),
  };
}

const TINY = {
  'requirements.json': { requirements: [{ key: 'R1' }, { key: 'R2' }] },
  'base-sets.json': { 'BASE-PAGE': { requirements: ['R1'] } },
  'strategies/lp.json': {
    catalog_id: 'LP',
    strategies: [
      { id: 'J1', requirement_keys: ['R1'] },
      { id: 'J2', requirement_keys: ['R2'], alias_of: 'J1' },
    ],
  },
  'crosswalk.json': { entries: [{ intent_id: 'i1', members: ['LP:J1'] }] },
  'screen-rules.json': { rules: [] },
  'standards.json': {},
  'descriptor.schema.json': {},
  'events.json': {},
  'funnels.json': { events: [], funnels: [] },
};

describe('CatalogSource', () => {
  it('the directory source builds the bundle loadCatalog caches', () => {
    expect(buildCatalog(directoryCatalogSource())).toEqual(loadCatalog());
    expect(loadCatalog()).toBe(loadCatalog());
  });

  it('builds and freezes a bundle from an in-memory source', () => {
    const bundle = buildCatalog(memorySource(TINY));
    expect(Object.keys(bundle.strategies)).toEqual(['LP']);
    expect(Object.isFrozen(bundle.strategies.LP.strategies[0])).toBe(true);
  });

  it('reports every validation error from the source', () => {
    const broken = {
      ...TINY,
      'strategies/lp.json': {
        catalog_id: 'LP',
        strategies: [
          { id: 'J1', requirement_keys: ['R9'] },
          { id: 'J1', requirement_keys: [], alias_of: 'J7' },
        ],
      },
      'crosswalk.json': { entries: [{ intent_id: 'i1', members: ['PO:A1'] }] },
    };
    expect(() => buildCatalog(memorySource(broken))).toThrow(
      'catalog bundle invalid:\nLP:J1 cites unregistered requirement R9\nduplicate strategy id LP:J1\nLP:J1 aliases unknown strategy J7\ncrosswalk i1 cites unknown strategy PO:A1',
    );
  });

  it('holds every funnel step to the closed event list', () => {
    const broken = {
      ...TINY,
      'funnels.json': {
        events: ['product_viewed', 'add_to_cart'],
        funnels: [
          { id: 'f1', steps: ['product_viewed', 'quiz_started'] },
          { id: 'f1', steps: ['add_to_cart'] },
        ],
      },
    };
    expect(() => buildCatalog(memorySource(broken))).toThrow(
      'catalog bundle invalid:\nfunnel f1 step quiz_started is outside the event list\nduplicate funnel id f1\nfunnel f1 needs two or more distinct steps',
    );
  });
});
