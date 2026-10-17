import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog/index.js';
import { PROVIDERS } from '../src/adapters/datasets/requirement-status.js';

/**
 * Catalog coverage (plan §13 catalog-coverage): every strategy cites
 * registered requirements; every registry code is either provided by a
 * Phase 1 dataset, an operator import, a planned connector mechanism, or
 * an explicitly listed not-yet-live query code. Counts: LP 41 / PO 41 /
 * PI 52 / PG 81 (incl. the PG:S12 alias) / TI 38 / TD 25 (incl. TD:FIX
 * and TD:F-ROUTE) / TG 35 / QZ 4 / XP 4; registry 101.
 */

const EXPECTED_COUNTS = { LP: 41, PO: 41, PI: 52, PG: 81, TI: 38, TD: 25, TG: 35, QZ: 4, XP: 4 };

// Query-mechanism codes with no live provider yet, computed from the
// registry itself: not provided by any dataset, and the registry does not
// mark them Live today (Probe / New / blank). H22 and H25 landed providers
// with the Phase 4 capture datasets (tap-geometry-weekly, template-weekly,
// kind-fleet-weekly); H27 stays uncovered by design (returning-history
// emits an explicit requirements override); V13 landed its Phase 5 provider
// (tool-registry); V01–V12 and V14–V15 stay uncovered (vendor waves,
// Phases 8–9). The Live assertion below fails the build if a Live-today
// query code ever lacks a provider again.
function expectedUnprovidedQuery(registry, provided) {
  return registry
    .filter(
      (r) => r.mechanism === 'query' && !provided.has(r.key) && !r.today.startsWith('Live'),
    )
    .map((r) => r.key)
    .sort();
}

// Live-today query codes still missing a PROVIDERS entry. Every pinned code
// has now landed a provider on this branch (H16 experiments-weekly, H26
// card-history), so the pin list is empty; the assertion below fails if a
// Live-today query code ever lacks a provider again.
const PINNED_LIVE_UNPROVIDED = [];

const CONNECTOR_MECHANISMS = new Set(['tracker', 'render', 'api']);

describe('catalog coverage', () => {
  const bundle = loadCatalog();
  const registry = bundle.requirements.requirements;
  const registryKeys = new Set(registry.map((r) => r.key));
  const provided = new Set(Object.values(PROVIDERS).flat());

  it('loadCatalog validates the bundle', () => {
    expect(() => loadCatalog()).not.toThrow();
    expect(bundle.crosswalk.entries.length).toBeGreaterThanOrEqual(55);
  });

  it('registry has 101 unique keys', () => {
    expect(registry).toHaveLength(101);
    expect(registryKeys.size).toBe(101);
  });

  it('catalog row counts are LP 41 / PO 41 / PI 52 / PG 81 / TI 38 / TD 25 / TG 35 / QZ 4 / XP 4', () => {
    for (const [catalogId, count] of Object.entries(EXPECTED_COUNTS)) {
      expect(bundle.strategies[catalogId].strategies, catalogId).toHaveLength(count);
    }
  });

  it('every strategy requirement key exists in the registry', () => {
    for (const catalog of Object.values(bundle.strategies)) {
      for (const strategy of catalog.strategies) {
        for (const key of strategy.requirement_keys) {
          expect(registryKeys.has(key), `${catalog.catalog_id}:${strategy.id} cites ${key}`).toBe(true);
        }
      }
    }
  });

  it('every dataset provides code exists in the registry or is a descriptor section', () => {
    // Lowercase codes are descriptor field sections (plan §10: tool-registry
    // provides V13 + s16), not registry keys; both come from the bundle.
    const descriptorSections = new Set(
      [...bundle.descriptorSchema.store_fields, ...bundle.descriptorSchema.page_fields].map(
        (f) => f.path.split('.')[0],
      ),
    );
    for (const [datasetId, codes] of Object.entries(PROVIDERS)) {
      for (const code of codes) {
        expect(
          registryKeys.has(code) || descriptorSections.has(code),
          `${datasetId} provides ${code}`,
        ).toBe(true);
      }
    }
  });

  it('every registry code is provided, operator, a planned connector, or a listed not-yet-live query code', () => {
    const unprovidedQuery = registry
      .filter((r) => !provided.has(r.key) && r.mechanism === 'query')
      .map((r) => r.key)
      .sort();
    expect(unprovidedQuery).toEqual(expectedUnprovidedQuery(registry, provided));

    for (const requirement of registry) {
      const covered =
        provided.has(requirement.key) ||
        requirement.mechanism === 'operator' ||
        CONNECTOR_MECHANISMS.has(requirement.mechanism) ||
        unprovidedQuery.includes(requirement.key);
      expect(covered, requirement.key).toBe(true);
    }
  });

  it('every registry row that is Live today with mechanism query has a PROVIDERS entry', () => {
    const liveUnprovided = registry
      .filter(
        (r) =>
          r.mechanism === 'query' &&
          r.today.startsWith('Live') &&
          !provided.has(r.key),
      )
      .map((r) => r.key)
      .sort();
    const pinnedLive = PINNED_LIVE_UNPROVIDED.filter((k) => {
      const row = registry.find((r) => r.key === k);
      return row && row.mechanism === 'query' && row.today.startsWith('Live') && !provided.has(k);
    }).sort();
    expect(liveUnprovided).toEqual(pinnedLive);

    const plainlyLive = registry.filter(
      (r) => r.mechanism === 'query' && /^[HM]/.test(r.key) && r.today === 'Live',
    );
    expect(plainlyLive.length).toBeGreaterThan(0);
    for (const requirement of plainlyLive) {
      expect(provided.has(requirement.key), requirement.key).toBe(true);
    }
  });
});
