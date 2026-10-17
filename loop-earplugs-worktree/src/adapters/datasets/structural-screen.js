import { loadCatalog } from '../../catalog/index.js';

/**
 * structural-screen: evaluates each catalog's screen rules (plan §7.4,
 * src/catalog/screen-rules.json) against the Phase-5 inputs that exist:
 * the descriptor-snapshot rows and requirement status. One row per rule:
 * dims {catalog_id, rule_id}, metrics {state, detail}.
 *
 * States: 'present' (structure confirmed), 'addable' (structure can be
 * added), 'blocked' (contradiction or required descriptor field not
 * current), 'unknown' (TG-only, when the field set cannot be resolved),
 * 'not_evaluable' (the S/V data the rule reads does not exist yet — the
 * row names the requirement codes, and cards treat it as pass with
 * structural_state 'present', recording the rule in the card notes).
 *
 * Concrete Phase-5 predicates:
 *   PO:G1 = p01.job current; PO:G2 = p04.first_viewport; PO:G3 =
 *   p10.hierarchy; PO:G4 = p08.commerce + p09.proof_risk; PO:G5 =
 *   p13.constraints readable (a row with a parseable value exists).
 *   PI:GATE3 = p08.commerce, p09.proof_risk, p12.tools all current
 *   ('present or addable'); PI:GATE4 = p13.constraints empty.
 * Everything else — the TI/TD/TG X contradictions, the TG anti-rule and
 * PG:GATE — reads S/V/measured data that lands in Phases 7–10, so it
 * reports 'not_evaluable' naming X_RULE_CODES (exported for Phase 10).
 *
 * Scope 'site' (§10.6: screens are per catalog, not per page); it reads
 * the descriptor-snapshot dataset from ctx when that ran. Absence of the
 * descriptor-snapshot dataset makes every descriptor-based rule
 * 'not_evaluable' — no rule is silently judged without its data.
 */

/**
 * X contradiction rule → the requirement codes it reads (plan §5.4/§5.5
 * strategy matrix, §7.4 contradiction notes; B4 for the Shop Pay pair).
 * Exported for Phase 10, when the S/V datasets behind these codes exist.
 * @type {Object<string, string[]>}
 */
export const X_RULE_CODES = Object.freeze({
  'TI:X01': ['S02', 'T15', 'V03'],
  'TI:X02': ['V13', 'M06'],
  'TI:X03': ['S01', 'T16'],
  'TI:X04': ['S01', 'S02'],
  'TI:X05': ['S09', 'V03', 'T15'],
  'TI:X06': ['S06', 'S07'],
  'TI:X07': ['S13', 'V03'],
  'TI:X08': ['T17', 'S05'],
  'TI:X09': ['V05', 'S05'],
  'TI:X10': ['V01', 'O05'],
  'TI:X11': ['V15', 'S10'],
  'TI:X12': ['V05', 'V08'],
  'TD:X01': ['S02', 'V03', 'T15'],
  'TD:X02': ['S01', 'T16'],
  'TD:X03': ['V13', 'T09'],
  'TD:X04': ['S06'],
  'TD:X05': ['T17', 'S05'],
  'TD:X06': ['V05', 'S05'],
  'TD:X07': ['V01', 'O05'],
  'TD:X08': ['S13', 'S16'],
  'TD:X09': ['V09', 'O02'],
  'TD:X10': ['T12', 'V13'],
  'TG:X01': ['S02', 'S14'],
  'TG:X02': ['V13', 'V03'],
  'TG:X03': ['S01', 'T16'],
  'TG:X04': ['V13', 'T09'],
  'TG:X05': ['S06'],
  'TG:X06': ['S07', 'S06'],
  'TG:X07': ['T17', 'S05'],
  'TG:X08': ['S09', 'V04'],
  'TG:X09': ['A01', 'H04'],
  'TG:X10': ['M02', 'M06'],
  // Non-Shopify equivalence reads the platform descriptor field (s30); no
  // requirement code fills it, so the field path rides in the codes list.
  'TG:X11': ['s30.platform', 'S01'],
  // PG:GATE + the structural inclusion rule: entry sessions and orders per
  // the PG gate standard (§11) — Phase-10 wiring.
  'PG:GATE': ['H01', 'H02'],
});

/**
 * Descriptor-based predicates keyed by rule id. Each receives the
 * descriptor rows (scope-filtered, one entry per row with parsed fields)
 * and returns {state, detail}.
 * @type {Object<string, (rows: Array<{field: string, status: string, value: unknown, owner: string}>) => {state: string, detail: string}>}
 */
const PREDICATES = {
  'PO:G1': (rows) => fieldCurrent(rows, 'p01.job'),
  'PO:G2': (rows) => fieldCurrent(rows, 'p04.first_viewport'),
  'PO:G3': (rows) => fieldCurrent(rows, 'p10.hierarchy'),
  'PO:G4': (rows) => {
    for (const field of ['p08.commerce', 'p09.proof_risk']) {
      const result = fieldCurrent(rows, field);
      if (result.state !== 'present') return result;
    }
    return { state: 'present', detail: 'p08.commerce + p09.proof_risk current' };
  },
  'PO:G5': (rows) => {
    const matching = rows.filter((r) => r.field === 'p13.constraints');
    if (matching.length === 0) {
      return { state: 'blocked', detail: 'p13.constraints not readable (no descriptor row)' };
    }
    const unreadable = matching.find(
      (r) => typeof r.value === 'string'
        && r.value.trim() !== ''
        && r.value.trim() !== 'null'
        && parseJsonValue(r.value) == null,
    );
    if (unreadable) {
      return { state: 'blocked', detail: 'p13.constraints not readable (unparseable value)' };
    }
    return { state: 'present', detail: 'p13.constraints readable' };
  },
  'PI:GATE3': (rows) => {
    for (const field of ['p08.commerce', 'p09.proof_risk', 'p12.tools']) {
      const result = fieldCurrent(rows, field);
      if (result.state !== 'present') return result;
    }
    return { state: 'present', detail: 'p08.commerce + p09.proof_risk + p12.tools current (structure present or addable)' };
  },
  'PI:GATE4': (rows) => {
    for (const row of rows.filter((r) => r.field === 'p13.constraints')) {
      const value = parseJsonValue(row.value);
      const forbids = Array.isArray(value) ? value.length > 0 : value != null && typeof value === 'object' && Object.keys(value).length > 0;
      if (forbids) {
        const owner = row.owner ? ` (owner ${row.owner})` : '';
        return { state: 'blocked', detail: `p13.constraints forbids${owner}` };
      }
    }
    return { state: 'present', detail: 'p13.constraints empty' };
  },
};

/**
 * @param {Array<{field: string, status: string}>} rows
 * @param {string} field
 * @returns {{state: string, detail: string}}
 */
function fieldCurrent(rows, field) {
  const matching = rows.filter((r) => r.field === field);
  if (matching.some((r) => r.status === 'current')) {
    return { state: 'present', detail: `${field} current` };
  }
  const seen = matching.map((r) => r.status).join(',') || 'no row';
  return { state: 'blocked', detail: `${field} not current (${seen})` };
}

/** @param {unknown} raw @returns {unknown} parsed value; null when empty/'null'/unparseable */
function parseJsonValue(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  const text = String(raw).trim();
  if (text === '' || text === 'null') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {Array<{dims: object, metrics: object}>} rows descriptor-snapshot rows
 * @returns {Map<string, Array<{field: string, status: string, value: unknown, owner: string}>>}
 *   descriptor scope ('page'|'store') → rows
 */
function rowsByScope(rows) {
  /** @type {Map<string, Array>} */
  const byScope = new Map();
  for (const row of rows) {
    const scope = String(row?.dims?.scope ?? '');
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push({
      field: String(row?.dims?.field_path ?? ''),
      status: String(row?.metrics?.status ?? 'unknown'),
      value: row?.metrics?.value_json,
      owner: String(row?.metrics?.owner ?? ''),
    });
  }
  return byScope;
}

export const adapter = {
  id: 'structural-screen',
  dependsOn: ['descriptor-snapshot'],
  scope: 'site',
  provides: [],

  /**
   * @param {{idsite: number, siteName: string}} page site-level page arg
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const bundle = loadCatalog();
    const descriptorRows = ctx.datasets.get('descriptor-snapshot')?.rows ?? null;
    const byScope = descriptorRows ? rowsByScope(descriptorRows) : null;

    const rows = [];
    const notEvaluable = [];
    for (const rule of bundle.screenRules.rules) {
      const predicate = PREDICATES[rule.id];
      if (!predicate) {
        const codes = rule.id === 'TG:ANTI_SHOP_PAY'
          ? []
          : (X_RULE_CODES[rule.id] ?? []);
        const detail = rule.id === 'TG:ANTI_SHOP_PAY'
          ? 'anti-rule (B4): must not be encoded; never evaluated'
          : `needs ${codes.join(', ')}`;
        rows.push({
          dims: { catalog_id: rule.catalog, rule_id: rule.id },
          metrics: { state: 'not_evaluable', detail },
        });
        if (rule.id !== 'TG:ANTI_SHOP_PAY') notEvaluable.push(rule.id);
        continue;
      }
      if (!byScope) {
        const fields = rule.id.startsWith('PO:')
          ? { 'PO:G1': 'p01.job', 'PO:G2': 'p04.first_viewport', 'PO:G3': 'p10.hierarchy', 'PO:G4': 'p08.commerce + p09.proof_risk', 'PO:G5': 'p13.constraints' }[rule.id]
          : 'p08.commerce + p09.proof_risk + p12.tools + p13.constraints';
        rows.push({
          dims: { catalog_id: rule.catalog, rule_id: rule.id },
          metrics: { state: 'not_evaluable', detail: `needs descriptor field(s) ${fields}` },
        });
        notEvaluable.push(rule.id);
        continue;
      }
      const scopeRows = byScope.get('page') ?? [];
      const result = predicate(scopeRows);
      rows.push({
        dims: { catalog_id: rule.catalog, rule_id: rule.id },
        metrics: { state: result.state, detail: result.detail },
      });
    }

    return {
      id: adapter.id,
      rows,
      notes: {
        screen_rules: rows.length,
        not_evaluable_rules: notEvaluable,
      },
    };
  },
};
