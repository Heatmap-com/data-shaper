import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog/index.js';

/**
 * Catalog schema (plan §13 catalog-schema): every strategies file has the
 * envelope shape and every strategy the required fields; standards cover
 * all seven catalogs; the descriptor schema covers exactly paths p00..p17
 * and s16..s37; screen-rule dispositions and ids are sane; the event
 * families cover T01..T20.
 */

const catalogDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/catalog/strategies');

const strategyFiles = readdirSync(catalogDir).filter((name) => name.endsWith('.json'));

const PAGE_PATHS = [
  'p00.walk', 'p01.job', 'p02.context', 'p03.offer', 'p04.first_viewport',
  'p05.traffic', 'p06.journey', 'p07.navigation', 'p08.commerce',
  'p09.proof_risk', 'p10.hierarchy', 'p11.affordances', 'p12.tools',
  'p13.constraints', 'p14.events', 'p15.revenue_join', 'p16.assets',
  'p17.calendar',
];

const STORE_PATHS = [
  's16.owners', 's17.gates', 's18.pp_eligibility', 's19.returns_portal',
  's20.returns_policy', 's21.reason_taxonomy', 's22.subscriptions',
  's23.identity', 's24.tool_events', 's25.reconciliation', 's26.economics',
  's27.offers', 's28.messages', 's29.recordings', 's30.platform',
  's31.consent', 's32.catalog_shape', 's33.fraud_policy', 's34.pos',
  's35.calendar', 's36.commercial', 's37.traffic_exclusion',
];

describe('catalog schema', () => {
  it('every strategies file has the envelope and each strategy the required fields', () => {
    expect(strategyFiles).toHaveLength(11);
    for (const file of strategyFiles) {
      const catalog = JSON.parse(readFileSync(path.join(catalogDir, file), 'utf8'));
      expect(typeof catalog.catalog_id, `${file} catalog_id`).toBe('string');
      expect(typeof catalog.catalog_version, `${file} catalog_version`).toBe('string');
      expect(Array.isArray(catalog.strategies), `${file} strategies`).toBe(true);
      for (const strategy of catalog.strategies) {
        const at = `${file}:${strategy.id ?? '?'}`;
        expect(typeof strategy.id, `${at} id`).toBe('string');
        expect(typeof strategy.family, `${at} family`).toBe('string');
        expect(typeof strategy.title, `${at} title`).toBe('string');
        expect(Array.isArray(strategy.requirement_keys), `${at} requirement_keys`).toBe(true);
        expect(typeof strategy.source_ref, `${at} source_ref`).toBe('string');
        expect(['page', 'site'], `${at} scope`).toContain(strategy.scope);
      }
    }
  });

  it('standards has an entry with a numeric window_days for all seven catalogs', () => {
    const bundle = loadCatalog();
    for (const catalogId of ['LP', 'PO', 'PI', 'PG', 'TI', 'TD', 'TG']) {
      const standard = bundle.standards.catalogs[catalogId];
      expect(standard, catalogId).toBeDefined();
      expect(typeof standard.window_days, `${catalogId} window_days`).toBe('number');
    }
  });

  it('descriptor schema covers exactly p00..p17 and s16..s37', () => {
    const bundle = loadCatalog();
    expect(bundle.descriptorSchema.page_fields.map((f) => f.path)).toEqual(PAGE_PATHS);
    expect(bundle.descriptorSchema.store_fields.map((f) => f.path)).toEqual(STORE_PATHS);
  });

  it('screen rules use known dispositions and unique ids', () => {
    const bundle = loadCatalog();
    const dispositions = new Set(['blocked', 'addable', 'conditional', 'unknown', 'exclude']);
    const ids = [];
    for (const rule of bundle.screenRules.rules) {
      expect(dispositions.has(rule.disposition), `${rule.id} disposition`).toBe(true);
      ids.push(rule.id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('event families cover T01..T20', () => {
    const bundle = loadCatalog();
    const codes = bundle.events.families.map((family) => family.family.split(' ')[0]);
    expect(codes).toHaveLength(20);
    expect(new Set(codes)).toEqual(new Set(Array.from({ length: 20 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`)));
  });
});
