import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../src/catalog/index.js';
import { TAXONOMY_VERSION } from '../src/domain/taxonomy.js';
import { discoverDatasets } from '../src/discover.js';
import { adapter as cardsLp } from '../src/adapters/datasets/cards-lp.js';
import { adapter as cardsPo } from '../src/adapters/datasets/cards-po.js';
import { adapter as cardsPi } from '../src/adapters/datasets/cards-pi.js';
import { adapter as cardsPg } from '../src/adapters/datasets/cards-pg.js';
import { adapter as cardsTi } from '../src/adapters/datasets/cards-ti.js';
import { adapter as cardsTd } from '../src/adapters/datasets/cards-td.js';
import { adapter as cardsTg } from '../src/adapters/datasets/cards-tg.js';

/**
 * Cards requirement gating (plan §13, Phase 5): one run of the seven
 * cards adapters over one page yields 311 cards (269 research + the
 * PG:S12 alias + 41 LP; TD:FIX and TD:F-ROUTE are fix rows, not
 * strategies — plan §5.5). Every card evaluates the §9.4 gate pipeline
 * before requirement gating. Three fixtures are exercised:
 *   - descriptors all current + capture current + no screens: the
 *     Phase-1 expectations reproduce for the page catalogs (PO:A1
 *     conditional, PG:S12 alias, LP:D7, LP:H1 reads its wrapped trigger
 *     row); site-catalog cards are now conditional too, because their
 *     gates pass — triggers arrive in Phase 10;
 *   - no descriptor-snapshot dataset at all: G1/G2 fail with 'no
 *     descriptor snapshot (Phase 5 pending)' — page catalogs
 *     conditional, site catalogs blocked, exactly the Phase-1 mapping;
 *   - G1 expired: conditional for page catalogs, blocked for site
 *     catalogs, per standards.json gates block.
 * No card is ever silent while a requirement is missing, and every card
 * carries attribution_label ('associated' without a counterfactual).
 * Statuses and gate inputs are injected directly: these tests do not run
 * requirement-status, descriptor-snapshot or structural-screen.
 */

const ADAPTERS = [cardsLp, cardsPo, cardsPi, cardsPg, cardsTi, cardsTd, cardsTg];

// 311 = 41 LP + 41 PO + 52 PI + 81 PG (incl. the PG:S12 alias)
//     + 38 TI + 23 TD (TD:FIX and TD:F-ROUTE skipped) + 35 TG.
const EXPECTED_CARD_COUNTS = {
  'cards-lp': 41,
  'cards-po': 41,
  'cards-pi': 52,
  'cards-pg': 81,
  'cards-ti': 38,
  'cards-td': 23,
  'cards-tg': 35,
};

const PAGE = { idsite: 1, idsitehsr: 99 };

/** A gateway whose ae_page_capture_current read says the capture is current. */
function captureCurrentGateway() {
  return {
    query: async (sql, params, label) =>
      label === 'cards:capture-status'
        ? [{ status: 'complete', taxonomy_version: TAXONOMY_VERSION }]
        : [],
  };
}

/** descriptor-snapshot rows with every page and store field current. */
function allCurrentDescriptors() {
  const bundle = loadCatalog();
  const rows = [
    ...bundle.descriptorSchema.page_fields.map((f) => ['page', f.path]),
    ...bundle.descriptorSchema.store_fields.map((f) => ['store', f.path]),
  ];
  return {
    id: 'descriptor-snapshot',
    rows: rows.map(([scope, field]) => ({
      dims: { scope, template_key: 'tpl', device_class: 'all', field_path: field },
      metrics: { status: 'current' },
    })),
  };
}

/**
 * @param {Object<string, string>} statusByKey overrides; every other
 *   registry key is 'available'
 * @param {object} [opts]
 * @param {object} [opts.gateway] ctx gateway (capture status read)
 * @param {boolean} [opts.descriptors] seed an all-current descriptor-snapshot
 */
function makeCtx(statusByKey = {}, opts = {}) {
  const bundle = loadCatalog();
  const rows = bundle.requirements.requirements.map((requirement) => ({
    dims: { requirement_key: requirement.key, scope_hint: requirement.domain },
    metrics: { status: statusByKey[requirement.key] ?? 'available', row_count: 1, detail: '' },
  }));
  const datasets = new Map([['requirement-status', { id: 'requirement-status', rows }]]);
  if (opts.descriptors) datasets.set('descriptor-snapshot', allCurrentDescriptors());
  const ctx = { datasets };
  if (opts.gateway) ctx.gateway = opts.gateway;
  return ctx;
}

async function collectAll(ctx) {
  /** @type {Map<string, import('../src/ports/dataset.js').Dataset>} */
  const out = new Map();
  for (const adapter of ADAPTERS) {
    out.set(adapter.id, await adapter.collect(PAGE, ctx));
  }
  return out;
}

function findCard(dataset, strategyId) {
  return dataset.rows.find((row) => row.dims.strategy_id === strategyId);
}

const OVERRIDES = { H10: 'missing', H18: 'missing', O01: 'unknown_value' };

describe('cards requirement gating: descriptors current + capture current + no screens', () => {
  const ctx = () => makeCtx(OVERRIDES, { descriptors: true, gateway: captureCurrentGateway() });

  it('one page yields 311 cards across the seven adapters', async () => {
    const results = await collectAll(ctx());
    const counts = Object.fromEntries([...results.entries()].map(([id, dataset]) => [id, dataset.rows.length]));
    for (const [id, expected] of Object.entries(EXPECTED_CARD_COUNTS)) {
      expect(counts[id], `card counts: ${JSON.stringify(counts)}`).toBe(expected);
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total, `card counts: ${JSON.stringify(counts)}`).toBe(311);
  });

  it('no card is silent while a requirement is missing', async () => {
    const results = await collectAll(ctx());
    for (const dataset of results.values()) {
      for (const row of dataset.rows) {
        expect(
          row.metrics.trigger_state === 'silent' && row.metrics.missing_requirements.length > 0,
          `${row.metrics.catalog_id}:${row.dims.strategy_id}`,
        ).toBe(false);
        expect(
          row.metrics.trigger_state === '' || row.metrics.trigger_evaluated === 1,
          `${row.metrics.catalog_id}:${row.dims.strategy_id}`,
        ).toBe(true);
      }
    }
  });

  it('PO:A1 needs H18; with H18 missing its card is conditional and lists it', async () => {
    const results = await collectAll(ctx());
    const card = findCard(results.get('cards-po'), 'PO:A1');
    expect(card).toBeDefined();
    expect(card.metrics.verdict).toBe('conditional');
    expect(card.metrics.missing_requirements).toEqual(['H18']);
  });

  it('a card with everything passing waits for Phase 10: conditional, trigger_evaluated 0', async () => {
    const results = await collectAll(ctx());
    const complete = findCard(results.get('cards-po'), 'PO:G2'); // cites O03 only
    expect(complete.metrics.missing_requirements).toEqual([]);
    expect(complete.metrics.verdict).toBe('conditional');
    expect(complete.metrics.trigger_evaluated).toBe(0);
    expect(complete.metrics.gate_failed).toBe('');
    expect(complete.metrics.detail).toContain('Phase 10');
    expect(complete.metrics.structural_state).toBe('present');
    expect(complete.metrics.attribution_label).toBe('associated');

    const incomplete = findCard(results.get('cards-po'), 'PO:A2');
    expect(incomplete.metrics.missing_requirements).toEqual(['H18', 'H10', 'O01']);
    expect(incomplete.metrics.verdict).toBe('conditional');
  });

  it('PG:S12 emits an alias card mirroring PG:A4', async () => {
    const results = await collectAll(ctx());
    const card = findCard(results.get('cards-pg'), 'PG:S12');
    expect(card).toBeDefined();
    expect(card.dims.alias_of).toBe('PG:A4');
    // PG:A4 cites M04, H18, H09, O01; the fixture marks H18 missing and
    // O01 unknown_value, so the mirrored card lists both.
    expect(card.metrics.missing_requirements).toEqual(['H18', 'O01']);
    expect(card.metrics.verdict).toBe('conditional');
  });

  it('LP:D7 needs H10; with H10 missing it is conditional and the trigger is not evaluated', async () => {
    const results = await collectAll(ctx());
    const card = findCard(results.get('cards-lp'), 'D7');
    expect(card).toBeDefined();
    expect(card.metrics.verdict).toBe('conditional');
    expect(card.metrics.missing_requirements).toEqual(['H10']);
    expect(card.metrics.trigger_evaluated).toBe(0);
    expect(card.metrics.trigger_state).toBe('');
  });

  it('LP:H1 with all requirements available reads its wrapped trigger row', async () => {
    const triggers = {
      id: 'strategy-triggers',
      rows: [
        {
          dims: { strategy_id: 'H1' },
          metrics: {
            state: 'triggered',
            metric: 'rage_sessions',
            value: 3,
            threshold: '>= 3 rage clicks on one selector',
            floor_result: 'met',
            rules: '8:triggered',
            detail: 'fixture trigger',
          },
        },
      ],
    };
    const context = makeCtx(OVERRIDES, { descriptors: true, gateway: captureCurrentGateway() });
    context.datasets.set('strategy-triggers', triggers);
    const results = await collectAll(context);
    const card = findCard(results.get('cards-lp'), 'H1');
    expect(card).toBeDefined();
    expect(card.metrics.verdict).toBe('include');
    expect(card.metrics.trigger_evaluated).toBe(1);
    expect(card.metrics.trigger_state).toBe('triggered');
    expect(card.metrics.metric).toBe('rage_sessions');
    expect(card.metrics.value).toBe(3);
    expect(card.metrics.threshold).toBe('>= 3 rage clicks on one selector');
  });

  it('site-catalog cards pass their gates and wait as conditional (Phase-1 blocked is gone)', async () => {
    const results = await collectAll(ctx());
    const card = findCard(results.get('cards-ti'), 'TI:G1');
    expect(card).toBeDefined();
    expect(card.metrics.verdict).toBe('conditional');
    expect(card.metrics.gate_failed).toBe('');
    expect(card.metrics.trigger_evaluated).toBe(0);
    expect(card.metrics.missing_requirements).toEqual([]);
  });

  it('a missing structural (render) requirement blocks the card and names it', async () => {
    const results = await collectAll(makeCtx({ M04: 'missing' }, { descriptors: true, gateway: captureCurrentGateway() }));
    const card = findCard(results.get('cards-po'), 'PO:C1'); // cites M04, M03, H09, T06, H18, H17
    expect(card.metrics.missing_requirements).toEqual(['M04']);
    expect(card.metrics.verdict).toBe('blocked');
    expect(card.metrics.gate_failed).toBe('structural_requirement');
  });
});

describe('cards requirement gating: no descriptor snapshot (Phase 5 pending)', () => {
  const ctx = () => makeCtx(OVERRIDES);

  it('still yields 311 cards and the Phase-1 verdicts: page conditional, site blocked', async () => {
    const results = await collectAll(ctx());
    const total = Object.values(Object.fromEntries([...results.entries()].map(([id, d]) => [id, d.rows.length])))
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(311);
    expect(findCard(results.get('cards-po'), 'PO:A1').metrics.verdict).toBe('conditional');
    expect(findCard(results.get('cards-ti'), 'TI:G1').metrics.verdict).toBe('blocked');
    expect(findCard(results.get('cards-td'), 'TD:G1').metrics.verdict).toBe('blocked');
    expect(findCard(results.get('cards-tg'), 'TG:A1').metrics.verdict).toBe('blocked');
  });

  it('G1/G2 fail with the pending detail and gate_failed descriptor; the trigger never runs', async () => {
    const results = await collectAll(ctx());
    const card = findCard(results.get('cards-ti'), 'TI:G1');
    expect(card.metrics.gate_failed).toBe('descriptor');
    expect(card.metrics.detail).toBe('no descriptor snapshot (Phase 5 pending)');
    expect(card.metrics.trigger_evaluated).toBe(0);

    const triggers = {
      id: 'strategy-triggers',
      rows: [
        {
          dims: { strategy_id: 'H1' },
          metrics: { state: 'triggered', metric: 'rage_sessions', value: 3, threshold: 't', floor_result: 'met', rules: '', detail: 'fixture' },
        },
      ],
    };
    const context = makeCtx(OVERRIDES);
    context.datasets.set('strategy-triggers', triggers);
    const withTriggers = await collectAll(context);
    const h1 = findCard(withTriggers.get('cards-lp'), 'H1');
    expect(h1.metrics.verdict).toBe('conditional');
    expect(h1.metrics.trigger_evaluated).toBe(0);
    expect(h1.metrics.gate_failed).toBe('descriptor');
  });

  it('missing requirements are still listed on top of the gate failure', async () => {
    const results = await collectAll(ctx());
    const card = findCard(results.get('cards-po'), 'PO:A1');
    expect(card.metrics.missing_requirements).toEqual(['H18']);
    expect(card.metrics.verdict).toBe('conditional');
  });
});

describe('cards requirement gating: G1 expired', () => {
  it('maps to conditional for page catalogs and blocked for site catalogs', async () => {
    const bundle = loadCatalog();
    const expired = {
      id: 'descriptor-snapshot',
      rows: [
        ...bundle.descriptorSchema.page_fields.map((f) => ({
          dims: { scope: 'page', template_key: 'tpl', device_class: 'all', field_path: f.path },
          metrics: { status: 'expired' },
        })),
        ...bundle.descriptorSchema.store_fields.map((f) => ({
          dims: { scope: 'store', template_key: 'tpl', device_class: 'all', field_path: f.path },
          metrics: { status: 'expired' },
        })),
      ],
    };
    const context = makeCtx({}, { gateway: captureCurrentGateway() });
    context.datasets.set('descriptor-snapshot', expired);
    const results = await collectAll(context);

    const po = findCard(results.get('cards-po'), 'PO:A1');
    expect(po.metrics.verdict).toBe('conditional');
    expect(po.metrics.gate_failed).toBe('descriptor');
    expect(po.metrics.detail).toContain('no current fields in page descriptor snapshot');

    const pi = findCard(results.get('cards-pi'), 'PI:A1');
    expect(pi.metrics.verdict).toBe('conditional');

    const ti = findCard(results.get('cards-ti'), 'TI:G1');
    expect(ti.metrics.verdict).toBe('blocked');
    expect(ti.metrics.detail).toContain('no current fields in store descriptor snapshot');

    const tg = findCard(results.get('cards-tg'), 'TG:A1');
    expect(tg.metrics.verdict).toBe('blocked');

    // LP keeps its wrapped trigger state only when gates pass; here the
    // descriptor gate stops it.
    const lp = findCard(results.get('cards-lp'), 'H1');
    expect(lp.metrics.verdict).toBe('conditional');
    expect(lp.metrics.trigger_evaluated).toBe(0);
  });

  it('names the first failing cited field for strategies with descriptor_refs', async () => {
    const bundle = loadCatalog();
    const rows = [
      ...bundle.descriptorSchema.page_fields.map((f) => ({
        dims: { scope: 'page', template_key: 'tpl', device_class: 'all', field_path: f.path },
        metrics: { status: 'current' },
      })),
      ...bundle.descriptorSchema.store_fields.map((f) => ({
        dims: { scope: 'store', template_key: 'tpl', device_class: 'all', field_path: f.path },
        metrics: { status: f.path === 's16.owners' ? 'expired' : 'current' },
      })),
    ];
    const context = makeCtx({}, { gateway: captureCurrentGateway() });
    context.datasets.set('descriptor-snapshot', { id: 'descriptor-snapshot', rows });
    const ti = await cardsTi.collect(PAGE, context);
    const a1 = findCard(ti, 'TI:A1'); // cites F16/F27 -> s16.owners expired
    expect(a1.metrics.verdict).toBe('blocked');
    expect(a1.metrics.detail).toContain('s16.owners expired');
  });
});

describe('cards dataset discovery', () => {
  it('the real dataset directory topologically sorts with cards after requirement-status', async () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/adapters/datasets');
    const datasets = await discoverDatasets(dir);
    const ids = datasets.map((d) => d.id);
    expect(ids).not.toContain('cards');
    expect(ids).toContain('requirement-status');
    expect(ids).toContain('structural-screen');
    for (const id of Object.keys(EXPECTED_CARD_COUNTS)) {
      expect(ids).toContain(id);
      expect(ids.indexOf(id)).toBeGreaterThan(ids.indexOf('requirement-status'));
    }
    expect(ids.indexOf('cards-lp')).toBeGreaterThan(ids.indexOf('strategy-triggers'));
  });
});
