import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog/index.js';
import { evaluateGates, mapGateFailure, GATE_IDS } from '../src/domain/gates.js';
import { buildCards } from '../src/adapters/datasets/_cards.js';

/**
 * Gates (plan §13 gates.test.js): each gate's failure maps to each
 * catalog's state (§9.4 failure column + standards.json gates block,
 * Appendix B B16); a missing requirement never yields a silent card;
 * attribution_label is 'associated' without a randomized counterfactual
 * and 'incremental' with one (B10).
 */

const bundle = loadCatalog();
const standards = bundle.standards;

const PAGE_FIELDS = bundle.descriptorSchema.page_fields.map((f) => f.path);
const STORE_FIELDS = bundle.descriptorSchema.store_fields.map((f) => f.path);
const ALL_CATALOGS = ['LP', 'PO', 'PI', 'PG', 'TI', 'TD', 'TG'];
const PAGE_CATALOGS = ['LP', 'PO', 'PI', 'PG'];

/**
 * @param {Array<[string, string, string, object?]>} entries
 *   [scope, field_path, status, extras?]
 * @returns {Map<string, *>}
 */
function snapshotMap(entries) {
  const map = new Map();
  for (const [scope, field, status, extras] of entries) {
    map.set(
      `${scope}|tpl|all|${field}`,
      extras ? { status, ...extras } : status,
    );
  }
  return map;
}

/** @param {string} scope @param {string[]} fields @param {string} [status] */
function snapshot(scope, fields, status = 'current') {
  return snapshotMap(fields.map((field) => [scope, field, status]));
}

/**
 * Gate inputs with every Phase-5 source green: all page/store descriptors
 * current, capture current, no screen result, signals default true.
 * @param {object} [overrides]
 */
function baseInputs(overrides = {}) {
  return {
    descriptorSnapshot: snapshotMap([
      ...PAGE_FIELDS.map((f) => ['page', f, 'current']),
      ...STORE_FIELDS.map((f) => ['store', f, 'current']),
    ]),
    captureStatus: 'current',
    ...overrides,
  };
}

/** @param {string} catalogId @param {string} strategyId */
function strategyOf(catalogId, strategyId) {
  const strategy = bundle.strategies[catalogId].strategies.find((s) => s.id === strategyId);
  if (!strategy) throw new Error(`no strategy ${catalogId}:${strategyId}`);
  return strategy;
}

/** @param {ReturnType<evaluateGates>} results @param {string} gate */
function gate(results, gateId) {
  return results.gates.find((g) => g.gate === gateId);
}

describe('evaluateGates: gate order and defaults', () => {
  it('returns G1..G9 in evaluation order', () => {
    const results = evaluateGates({ strategy: strategyOf('PO', 'PO:A1'), catalogId: 'PO', inputs: baseInputs(), standards });
    expect(results.gates.map((g) => g.gate)).toEqual(GATE_IDS);
    expect(results.firstFailure).toBeNull();
    expect(results.structuralState).toBe('present');
  });

  it('default inputs make G6..G9 pass (Phase 10 wiring)', () => {
    for (const catalogId of ALL_CATALOGS) {
      const strategy = bundle.strategies[catalogId].strategies[0];
      const results = evaluateGates({ strategy, catalogId, inputs: baseInputs(), standards });
      for (const g of ['G6', 'G7', 'G8', 'G9']) {
        expect(gate(results, g).passed, `${catalogId} ${g}`).toBe(true);
      }
    }
  });
});

describe('G1 descriptor current: per-catalog failure mapping (matrix)', () => {
  for (const catalogId of ALL_CATALOGS) {
    it(`${catalogId}: expired descriptor maps to ${PAGE_CATALOGS.includes(catalogId) ? 'conditional' : 'blocked'} with trigger_evaluated 0`, () => {
      const strategy = bundle.strategies[catalogId].strategies[0];
      const scope = PAGE_CATALOGS.includes(catalogId) ? 'page' : 'store';
      const inputs = baseInputs({
        descriptorSnapshot: snapshot(scope, scope === 'page' ? PAGE_FIELDS : STORE_FIELDS, 'expired'),
      });
      const results = evaluateGates({ strategy, catalogId, inputs, standards });
      const g1 = gate(results, 'G1');
      expect(g1.passed).toBe(false);
      expect(results.firstFailure.gate).toBe('G1');
      const mapped = mapGateFailure(catalogId, 'G1', standards);
      expect(mapped.verdict).toBe(PAGE_CATALOGS.includes(catalogId) ? 'conditional' : 'blocked');
      expect(mapped.triggerEvaluated).toBe(0);
      expect(['conditional', 'blocked']).toContain(mapped.verdict); // never silent
    });
  }

  it('names the first failing cited field path (TI:A1 cites F16/F27)', () => {
    const inputs = baseInputs({
      descriptorSnapshot: snapshotMap([
        ['store', 's16.owners', 'expired'],
        ['store', 's27.offers', 'current'],
        ...PAGE_FIELDS.map((f) => ['page', f, 'current']),
      ]),
    });
    const results = evaluateGates({ strategy: strategyOf('TI', 'TI:A1'), catalogId: 'TI', inputs, standards });
    const g1 = gate(results, 'G1');
    expect(g1.passed).toBe(false);
    expect(g1.detail).toContain('s16.owners');
    expect(mapGateFailure('TI', 'G1', standards).verdict).toBe('blocked');
  });

  it('fails when a cited field has no descriptor row at all', () => {
    const inputs = baseInputs({ descriptorSnapshot: snapshot('page', PAGE_FIELDS) }); // no store rows
    const results = evaluateGates({ strategy: strategyOf('TI', 'TI:A1'), catalogId: 'TI', inputs, standards });
    const g1 = gate(results, 'G1');
    expect(g1.passed).toBe(false);
    expect(g1.detail).toContain('s16');
  });

  it('absent descriptor snapshot fails G1 and G2 with the Phase-5-pending detail', () => {
    const results = evaluateGates({
      strategy: strategyOf('PO', 'PO:A1'),
      catalogId: 'PO',
      inputs: { descriptorSnapshot: null, captureStatus: 'current' },
      standards,
    });
    expect(gate(results, 'G1').passed).toBe(false);
    expect(gate(results, 'G1').detail).toBe('no descriptor snapshot (Phase 5 pending)');
    expect(gate(results, 'G2').passed).toBe(false);
    expect(gate(results, 'G2').detail).toBe('no descriptor snapshot (Phase 5 pending)');
    expect(gate(results, 'G3').passed).toBe(true); // later gates still evaluate
  });
});

describe('G1 unknown (low-confidence) fields per B16', () => {
  it('TI: an unknown cited field is blocked', () => {
    const inputs = baseInputs({
      descriptorSnapshot: snapshotMap([
        ['store', 's16.owners', 'unknown'],
        ['store', 's27.offers', 'current'],
        ...PAGE_FIELDS.map((f) => ['page', f, 'current']),
      ]),
    });
    const results = evaluateGates({ strategy: strategyOf('TI', 'TI:A1'), catalogId: 'TI', inputs, standards });
    const g1 = gate(results, 'G1');
    expect(g1.passed).toBe(false);
    expect(g1.fieldStatus).toBe('unknown');
    expect(g1.detail).toContain('s16.owners');
    const mapped = mapGateFailure('TI', 'G1', standards, { fieldStatus: 'unknown' });
    expect(mapped.verdict).toBe('blocked');
  });

  it('PO: an unknown field maps to conditional', () => {
    const mapped = mapGateFailure('PO', 'G1', standards, { fieldStatus: 'unknown' });
    expect(mapped.verdict).toBe('conditional');
    expect(mapped.triggerEvaluated).toBe(0);
  });

  it('TD: an unknown field maps to conditional with the confidence cap named', () => {
    const mapped = mapGateFailure('TD', 'G1', standards, { fieldStatus: 'unknown' });
    expect(mapped.verdict).toBe('conditional');
    expect(standards.catalogs.TD.gates.unknown_fields).toBe('confidence_cap');
    expect(standards.catalogs.TD.confidence.max_if_unknown_field).toBeLessThanOrEqual(0.3);
  });

  it('TG: an unknown-only store snapshot passes with structural_state unknown', () => {
    const inputs = baseInputs({
      descriptorSnapshot: snapshot('store', STORE_FIELDS, 'unknown'),
    });
    const results = evaluateGates({ strategy: strategyOf('TG', 'TG:A1'), catalogId: 'TG', inputs, standards });
    expect(gate(results, 'G1').passed).toBe(true);
    expect(results.structuralState).toBe('unknown');
  });
});

describe('G2 capture current', () => {
  it.each(['stale', 'missing'])('capture %s fails G2 with the same mapping as G1', (captureStatus) => {
    for (const catalogId of ['PO', 'TI']) {
      const strategy = bundle.strategies[catalogId].strategies[0];
      const results = evaluateGates({
        strategy,
        catalogId,
        inputs: baseInputs({ captureStatus }),
        standards,
      });
      const g2 = gate(results, 'G2');
      expect(g2.passed, `${catalogId} ${captureStatus}`).toBe(false);
      expect(g2.detail).toContain(`capture ${captureStatus}`);
      const mapped = mapGateFailure(catalogId, 'G2', standards);
      expect(mapped.verdict).toBe(catalogId === 'PO' ? 'conditional' : 'blocked');
    }
  });

  it('capture current passes G2', () => {
    const results = evaluateGates({
      strategy: strategyOf('PO', 'PO:A1'),
      catalogId: 'PO',
      inputs: baseInputs({ captureStatus: 'current' }),
      standards,
    });
    expect(gate(results, 'G2').passed).toBe(true);
  });
});

describe('G3 signals valid', () => {
  it('each false signal fails G3 naming the signal', () => {
    const cases = [
      ['botShareOk', 'bot_share'],
      ['instrumentationChangeInWindow', 'instrumentation_change'],
      ['eventValidated', 'event_validation'],
      ['experimentOverlap', 'experiment_overlap'],
      ['promoWindow', 'promo_window'],
    ];
    for (const [key, name] of cases) {
      const results = evaluateGates({
        strategy: strategyOf('PO', 'PO:A1'),
        catalogId: 'PO',
        inputs: baseInputs({ signals: { [key]: false } }),
        standards,
      });
      const g3 = gate(results, 'G3');
      expect(g3.passed, key).toBe(false);
      expect(g3.detail).toContain(name);
      expect(mapGateFailure('PO', 'G3', standards).verdict).toBe('conditional');
      expect(mapGateFailure('TI', 'G3', standards).verdict).toBe('blocked');
    }
  });
});

describe('G4 structure permits: screen dispositions', () => {
  it('blocked state fails G4; the rule disposition maps blocked/exclude/conditional', () => {
    const results = evaluateGates({
      strategy: strategyOf('PI', 'PI:A1'),
      catalogId: 'PI',
      inputs: baseInputs({
        screenResult: { state: 'blocked', ruleId: 'PI:GATE3', disposition: 'blocked', detail: 'p08.commerce not current' },
      }),
      standards,
    });
    const g4 = gate(results, 'G4');
    expect(g4.passed).toBe(false);
    expect(g4.detail).toContain('PI:GATE3');
    expect(results.structuralState).toBe('blocked');
    expect(results.screenRuleId).toBe('PI:GATE3');
    expect(mapGateFailure('PI', 'G4', standards, { disposition: 'blocked' }).verdict).toBe('blocked');
    // PI excludes a structural contradiction (§9.4 G4).
    expect(mapGateFailure('PI', 'G4', standards, { disposition: 'exclude' }).verdict).toBe('exclude');
    expect(mapGateFailure('TD', 'G4', standards, { disposition: 'conditional' }).verdict).toBe('conditional');
  });

  it('addable and unknown states pass with their structural_state', () => {
    const addable = evaluateGates({
      strategy: strategyOf('TD', 'TD:G1'),
      catalogId: 'TD',
      inputs: baseInputs({ screenResult: { state: 'addable', ruleId: 'TD:X07', disposition: 'addable' } }),
      standards,
    });
    expect(gate(addable, 'G4').passed).toBe(true);
    expect(addable.structuralState).toBe('addable');

    const unknown = evaluateGates({
      strategy: strategyOf('TG', 'TG:A1'),
      catalogId: 'TG',
      inputs: baseInputs({ screenResult: { state: 'unknown', ruleId: 'TG:X01', disposition: 'blocked' } }),
      standards,
    });
    expect(gate(unknown, 'G4').passed).toBe(true);
    expect(unknown.structuralState).toBe('unknown');
  });

  it('no screen result (null) passes as present', () => {
    const results = evaluateGates({
      strategy: strategyOf('PO', 'PO:A1'),
      catalogId: 'PO',
      inputs: baseInputs({ screenResult: null }),
      standards,
    });
    expect(gate(results, 'G4').passed).toBe(true);
    expect(results.structuralState).toBe('present');
  });
});

describe('G5 no constraint forbids', () => {
  it('a non-empty p13.constraints fails G5 with the field and owner, mapped to exclude', () => {
    const inputs = baseInputs({
      descriptorSnapshot: snapshotMap([
        ...PAGE_FIELDS.map((f) => ['page', f, 'current']),
        ['page', 'p13.constraints', 'current', { value_json: '{"no_move":"legal"}', owner: 'ops-lead' }],
        ...STORE_FIELDS.map((f) => ['store', f, 'current']),
      ]),
    });
    const results = evaluateGates({ strategy: strategyOf('PI', 'PI:A1'), catalogId: 'PI', inputs, standards });
    const g5 = gate(results, 'G5');
    expect(g5.passed).toBe(false);
    expect(g5.detail).toContain('p13.constraints');
    expect(g5.detail).toContain('ops-lead');
    const mapped = mapGateFailure('PI', 'G5', standards);
    expect(mapped.verdict).toBe('exclude');
    expect(mapped.triggerEvaluated).toBe(0);
  });

  it('store strategies read s31.consent + s33.fraud_policy', () => {
    const inputs = baseInputs({
      descriptorSnapshot: snapshotMap([
        ...PAGE_FIELDS.map((f) => ['page', f, 'current']),
        ...STORE_FIELDS.map((f) => ['store', f, 'current']),
        ['store', 's33.fraud_policy', 'current', { value_json: '{"auto_deny_above": 500}', owner: 'risk' }],
      ]),
    });
    const results = evaluateGates({ strategy: strategyOf('TI', 'TI:A1'), catalogId: 'TI', inputs, standards });
    const g5 = gate(results, 'G5');
    expect(g5.passed).toBe(false);
    expect(g5.detail).toContain('s33.fraud_policy');
    expect(g5.detail).toContain('risk');
  });

  it.each(['[]', '{}', 'null', '', undefined])('empty constraint value %j passes G5', (valueJson) => {
    const inputs = baseInputs({
      descriptorSnapshot: snapshotMap([
        ...PAGE_FIELDS.map((f) => ['page', f, 'current']),
        ['page', 'p13.constraints', 'current', valueJson === undefined ? {} : { value_json: valueJson }],
        ...STORE_FIELDS.map((f) => ['store', f, 'current']),
      ]),
    });
    const results = evaluateGates({ strategy: strategyOf('PO', 'PO:A1'), catalogId: 'PO', inputs, standards });
    expect(gate(results, 'G5').passed).toBe(true);
  });
});

describe('G6-G8 wiring', () => {
  it('G6 below_floor fails conditional with the sample gap', () => {
    const results = evaluateGates({
      strategy: strategyOf('PO', 'PO:A1'),
      catalogId: 'PO',
      inputs: baseInputs({ floorResult: 'below_floor', sampleGap: '212 sessions' }),
      standards,
    });
    const g6 = gate(results, 'G6');
    expect(g6.passed).toBe(false);
    expect(g6.detail).toContain('212 sessions');
    expect(mapGateFailure('PO', 'G6', standards).verdict).toBe('conditional');
  });

  it('G7 confound open fails as exclude with exclusion re-eval', () => {
    const results = evaluateGates({
      strategy: strategyOf('PO', 'PO:A1'),
      catalogId: 'PO',
      inputs: baseInputs({ confoundOpen: 'H16 experiment overlap' }),
      standards,
    });
    const g7 = gate(results, 'G7');
    expect(g7.passed).toBe(false);
    expect(g7.detail).toContain('H16 experiment overlap');
    expect(mapGateFailure('PO', 'G7', standards).verdict).toBe('exclude');
  });

  it('G8 segment reversal fails conditional scoped to the cut', () => {
    const results = evaluateGates({
      strategy: strategyOf('PI', 'PI:A1'),
      catalogId: 'PI',
      inputs: baseInputs({ segmentReversal: 'mobile cut' }),
      standards,
    });
    const g8 = gate(results, 'G8');
    expect(g8.passed).toBe(false);
    expect(g8.detail).toContain('mobile cut');
    expect(mapGateFailure('PI', 'G8', standards).verdict).toBe('conditional');
  });
});

describe('G9 revenue join and economics', () => {
  it('an unconfirmed join fails G9 as conditional not confirmed', () => {
    const results = evaluateGates({
      strategy: strategyOf('PO', 'PO:A1'),
      catalogId: 'PO',
      inputs: baseInputs({ revenueJoin: { confirmed: false } }),
      standards,
    });
    const g9 = gate(results, 'G9');
    expect(g9.passed).toBe(false);
    expect(g9.detail).toBe('revenue join not confirmed');
    expect(mapGateFailure('PO', 'G9', standards).verdict).toBe('conditional');
  });

  it('unconfirmed economics fails G9', () => {
    const results = evaluateGates({
      strategy: strategyOf('TG', 'TG:A1'),
      catalogId: 'TG',
      inputs: baseInputs({ economicsConfirmed: false }),
      standards,
    });
    expect(gate(results, 'G9').passed).toBe(false);
  });

  it('D-family strategies bypass G9 with a deterministic-repro verdict (B9)', () => {
    const inputs = baseInputs({ revenueJoin: { confirmed: false }, reproPassed: true });
    const dFamily = evaluateGates({ strategy: strategyOf('PI', 'PI:D1'), catalogId: 'PI', inputs, standards });
    expect(gate(dFamily, 'G9').passed).toBe(true);

    // Without the repro verdict the same strategy fails G9.
    const noRepro = evaluateGates({
      strategy: strategyOf('PI', 'PI:D1'),
      catalogId: 'PI',
      inputs: baseInputs({ revenueJoin: { confirmed: false } }),
      standards,
    });
    expect(gate(noRepro, 'G9').passed).toBe(false);

    // A non-D strategy does not bypass.
    const nonD = evaluateGates({ strategy: strategyOf('PI', 'PI:A1'), catalogId: 'PI', inputs, standards });
    expect(gate(nonD, 'G9').passed).toBe(false);
  });
});

describe('attribution label (B10)', () => {
  it('is associated without a randomized counterfactual', () => {
    const results = evaluateGates({
      strategy: strategyOf('TG', 'TG:A1'),
      catalogId: 'TG',
      inputs: baseInputs(),
      standards,
    });
    expect(results.attributionLabel).toBe('associated');
  });

  it('is incremental only with a randomized or holdout counterfactual', () => {
    const results = evaluateGates({
      strategy: strategyOf('TG', 'TG:A1'),
      catalogId: 'TG',
      inputs: baseInputs({ randomizedCounterfactual: true }),
      standards,
    });
    expect(results.attributionLabel).toBe('incremental');
  });
});

describe('a missing requirement never yields a silent card (regression)', () => {
  it('a card with a missing requirement is conditional and names the code', async () => {
    const bundle = loadCatalog();
    const rows = bundle.requirements.requirements.map((requirement) => ({
      dims: { requirement_key: requirement.key, scope_hint: requirement.domain },
      metrics: { status: requirement.key === 'H18' ? 'missing' : 'available', row_count: 1, detail: '' },
    }));
    const ctx = { datasets: new Map([['requirement-status', { id: 'requirement-status', rows }]]) };
    const dataset = await buildCards('PO', ctx, { idsite: 1, idsitehsr: 99 });
    const card = dataset.rows.find((r) => r.dims.strategy_id === 'PO:A1');
    expect(card).toBeDefined();
    expect(card.metrics.verdict).not.toBe('silent');
    expect(card.metrics.missing_requirements).toEqual(['H18']);
    // Gate failure (no descriptor snapshot) maps PO to conditional.
    expect(card.metrics.verdict).toBe('conditional');
    expect(card.metrics.gate_failed).toBe('descriptor');
  });
});
