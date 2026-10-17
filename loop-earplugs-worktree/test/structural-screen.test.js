import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog/index.js';
import { adapter, X_RULE_CODES } from '../src/adapters/datasets/structural-screen.js';

/**
 * structural-screen (plan §13, Phase 5 exit): PO gates G1-G5 evaluate from
 * descriptor rows (p01.job, p04.first_viewport, p10.hierarchy,
 * p08.commerce + p09.proof_risk, p13.constraints readable); PI GATE3
 * reads p08/p09/p12, PI GATE4 reads p13.constraints; the TI/TD/TG X
 * contradictions and PG:GATE need S/V/measured data that lands in
 * Phases 7-10, so they report not_evaluable naming the requirement codes
 * they would read (X_RULE_CODES, exported for Phase 10).
 */

const bundle = loadCatalog();
const PAGE_FIELDS = bundle.descriptorSchema.page_fields.map((f) => f.path);

/**
 * @param {Array<[string, string, string, object?]>} entries
 *   [scope, field_path, status, extraMetrics?]
 */
function descriptorRows(entries) {
  return entries.map(([scope, field, status, extra]) => ({
    dims: { scope, template_key: 'tpl', device_class: 'all', field_path: field },
    metrics: { status, ...(extra ?? {}) },
  }));
}

const ALL_PAGE_CURRENT = PAGE_FIELDS.map((f) => ['page', f, 'current']);

/**
 * @param {Array} rows descriptor-snapshot rows (null = dataset absent)
 */
function makeCtx(rows) {
  const datasets = new Map();
  if (rows) datasets.set('descriptor-snapshot', { id: 'descriptor-snapshot', rows });
  return { datasets };
}

const SITE_PAGE = { idsite: 1, siteName: 'x' };

/** @param {import('../../ports/dataset.js').Dataset} dataset @param {string} ruleId */
function ruleRow(dataset, ruleId) {
  return dataset.rows.find((r) => r.dims.rule_id === ruleId);
}

describe('structural-screen: PO gates G1-G5 from descriptor rows', () => {
  it('all-current descriptors make every PO gate present', async () => {
    const dataset = await adapter.collect(SITE_PAGE, makeCtx(descriptorRows(ALL_PAGE_CURRENT)));
    for (const id of ['PO:G1', 'PO:G2', 'PO:G3', 'PO:G4', 'PO:G5']) {
      const row = ruleRow(dataset, id);
      expect(row, id).toBeDefined();
      expect(row.metrics.state, id).toBe('present');
    }
    expect(ruleRow(dataset, 'PO:G1').metrics.detail).toContain('p01.job');
    expect(ruleRow(dataset, 'PO:G4').metrics.detail).toContain('p08.commerce');
  });

  it('PO:G1 blocks when p01.job is expired, naming the field', async () => {
    const rows = descriptorRows(ALL_PAGE_CURRENT.map(([s, f, st]) => (f === 'p01.job' ? [s, f, 'expired'] : [s, f, st])));
    const dataset = await adapter.collect(SITE_PAGE, makeCtx(rows));
    const row = ruleRow(dataset, 'PO:G1');
    expect(row.metrics.state).toBe('blocked');
    expect(row.metrics.detail).toContain('p01.job');
    expect(row.metrics.detail).toContain('expired');
  });

  it('PO:G4 blocks on p09.proof_risk even when p08.commerce is current', async () => {
    const rows = descriptorRows(ALL_PAGE_CURRENT.map(([s, f, st]) => (f === 'p09.proof_risk' ? [s, f, 'expired'] : [s, f, st])));
    const dataset = await adapter.collect(SITE_PAGE, makeCtx(rows));
    const row = ruleRow(dataset, 'PO:G4');
    expect(row.metrics.state).toBe('blocked');
    expect(row.metrics.detail).toContain('p09.proof_risk');
  });

  it('PO:G5 requires a readable p13.constraints row', async () => {
    const without = ALL_PAGE_CURRENT.filter(([, f]) => f !== 'p13.constraints');
    const dataset = await adapter.collect(SITE_PAGE, makeCtx(descriptorRows(without)));
    expect(ruleRow(dataset, 'PO:G5').metrics.state).toBe('blocked');
    expect(ruleRow(dataset, 'PO:G5').metrics.detail).toContain('not readable');

    const unparseable = descriptorRows(
      ALL_PAGE_CURRENT.map(([s, f, st]) => (f === 'p13.constraints' ? [s, f, st, { value_json: '{not json' }] : [s, f, st])),
    );
    const dataset2 = await adapter.collect(SITE_PAGE, makeCtx(unparseable));
    expect(ruleRow(dataset2, 'PO:G5').metrics.state).toBe('blocked');
  });
});

describe('structural-screen: PI GATE3/GATE4 from p08/p09/p12/p13', () => {
  it('GATE3 is present when p08, p09 and p12 are current', async () => {
    const dataset = await adapter.collect(SITE_PAGE, makeCtx(descriptorRows(ALL_PAGE_CURRENT)));
    expect(ruleRow(dataset, 'PI:GATE3').metrics.state).toBe('present');
    expect(ruleRow(dataset, 'PI:GATE4').metrics.state).toBe('present');
  });

  it('GATE3 blocks naming the first non-current field', async () => {
    const rows = descriptorRows(ALL_PAGE_CURRENT.map(([s, f, st]) => (f === 'p12.tools' ? [s, f, 'expired'] : [s, f, st])));
    const dataset = await adapter.collect(SITE_PAGE, makeCtx(rows));
    const row = ruleRow(dataset, 'PI:GATE3');
    expect(row.metrics.state).toBe('blocked');
    expect(row.metrics.detail).toContain('p12.tools');
  });

  it('GATE4 blocks with the owner when p13.constraints forbids', async () => {
    const rows = descriptorRows(
      ALL_PAGE_CURRENT.map(([s, f, st]) =>
        f === 'p13.constraints' ? [s, f, st, { value_json: '{"freeze_order":"legal"}', owner: 'ops' }] : [s, f, st],
      ),
    );
    const dataset = await adapter.collect(SITE_PAGE, makeCtx(rows));
    const row = ruleRow(dataset, 'PI:GATE4');
    expect(row.metrics.state).toBe('blocked');
    expect(row.metrics.detail).toContain('p13.constraints');
    expect(row.metrics.detail).toContain('ops');
  });

  it('GATE4 stays present for empty, null and missing constraint values', async () => {
    for (const valueJson of ['[]', '{}', 'null']) {
      const rows = descriptorRows(
        ALL_PAGE_CURRENT.map(([s, f, st]) => (f === 'p13.constraints' ? [s, f, st, { value_json: valueJson }] : [s, f, st])),
      );
      const dataset = await adapter.collect(SITE_PAGE, makeCtx(rows));
      expect(ruleRow(dataset, 'PI:GATE4').metrics.state, valueJson).toBe('present');
    }
    const without = descriptorRows(ALL_PAGE_CURRENT.filter(([, f]) => f !== 'p13.constraints'));
    const dataset = await adapter.collect(SITE_PAGE, makeCtx(without));
    expect(ruleRow(dataset, 'PI:GATE4').metrics.state).toBe('present');
  });
});

describe('structural-screen: X contradictions are not_evaluable, naming their codes', () => {
  it('every TI/TD/TG X rule reports not_evaluable with the codes it needs', async () => {
    const dataset = await adapter.collect(SITE_PAGE, makeCtx(descriptorRows(ALL_PAGE_CURRENT)));
    const xRules = bundle.screenRules.rules.filter((r) => /^(TI|TD|TG):X\d+/.test(r.id));
    expect(xRules.length).toBeGreaterThan(0);
    for (const rule of xRules) {
      const row = ruleRow(dataset, rule.id);
      expect(row, rule.id).toBeDefined();
      expect(row.metrics.state, rule.id).toBe('not_evaluable');
      const codes = X_RULE_CODES[rule.id] ?? [];
      expect(codes.length, rule.id).toBeGreaterThan(0);
      expect(row.metrics.detail, rule.id).toBe(`needs ${codes.join(', ')}`);
    }
    // Spot checks against the §5.4/§5.5 matrix.
    expect(X_RULE_CODES['TI:X04']).toEqual(['S01', 'S02']); // B4: Shop Pay reads S01 + the S02 accelerated share
    expect(X_RULE_CODES['TD:X08']).toEqual(['S13', 'S16']); // no credit rail
    expect(X_RULE_CODES['TG:X11']).toContain('s30.platform'); // non-Shopify equivalence
  });

  it('the TG anti-rule is never encoded (B4)', async () => {
    const dataset = await adapter.collect(SITE_PAGE, makeCtx(descriptorRows(ALL_PAGE_CURRENT)));
    const row = ruleRow(dataset, 'TG:ANTI_SHOP_PAY');
    expect(row.metrics.state).toBe('not_evaluable');
    expect(row.metrics.detail).toContain('anti-rule');
  });

  it('PG:GATE is Phase-10 wiring', async () => {
    const dataset = await adapter.collect(SITE_PAGE, makeCtx(descriptorRows(ALL_PAGE_CURRENT)));
    const row = ruleRow(dataset, 'PG:GATE');
    expect(row.metrics.state).toBe('not_evaluable');
    expect(row.metrics.detail).toContain('needs H01, H02');
  });

  it('rows carry dims {catalog_id, rule_id} and list the unevaluated rules in notes', async () => {
    const dataset = await adapter.collect(SITE_PAGE, makeCtx(descriptorRows(ALL_PAGE_CURRENT)));
    expect(dataset.id).toBe('structural-screen');
    for (const row of dataset.rows) {
      expect(row.dims.catalog_id).toMatch(/^(LP|PO|PI|PG|TI|TD|TG)$/);
      expect(typeof row.dims.rule_id).toBe('string');
      expect(['present', 'addable', 'blocked', 'unknown', 'not_evaluable']).toContain(row.metrics.state);
    }
    expect(dataset.notes.not_evaluable_rules.length).toBeGreaterThan(0);
    expect(dataset.notes.not_evaluable_rules).not.toContain('TG:ANTI_SHOP_PAY');
  });
});

describe('structural-screen: without a descriptor snapshot nothing is judged', () => {
  it('descriptor-based rules report not_evaluable naming their fields', async () => {
    const dataset = await adapter.collect(SITE_PAGE, makeCtx(null));
    for (const id of ['PO:G1', 'PI:GATE3', 'PI:GATE4']) {
      const row = ruleRow(dataset, id);
      expect(row.metrics.state, id).toBe('not_evaluable');
      expect(row.metrics.detail, id).toContain('needs descriptor field');
    }
  });

  it('depends on the descriptor-snapshot dataset', () => {
    expect(adapter.id).toBe('structural-screen');
    expect(adapter.scope).toBe('site');
    expect(adapter.provides).toEqual([]);
    expect(adapter.dependsOn).toEqual(['descriptor-snapshot']);
  });
});
