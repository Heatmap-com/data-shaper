import { configuredDatabase } from '../query-gateway/clickhouse.js';
import { loadCatalog } from '../../catalog/index.js';
import { TAXONOMY_VERSION } from '../../domain/taxonomy.js';
import { evaluateGates, mapGateFailure } from '../../domain/gates.js';

/**
 * Shared card builder for the seven strategy catalogs. Every strategy row
 * becomes one card; the PG:S12 alias row mirrors its target (PG:A4) and
 * carries dims.alias_of. Phase 5 (plan §9.4): each card evaluates the gate
 * pipeline (src/domain/gates.js) BEFORE requirement gating — G1 descriptor
 * current, G2 capture current, G3 signals, G4 structural screen, G5
 * constraints — and a gate failure sets verdict / trigger_evaluated /
 * structural_state / gate_failed via the catalog's standards.json gates
 * mapping ('conditional' page catalogs = stop with trigger_evaluated 0,
 * 'blocked' site catalogs). Requirement gating then still applies on top:
 * a card with a missing or expired requirement is never silent
 * (conditional for instrumentation or sample requirements, blocked for
 * structural ones) and always lists the codes in missing_requirements.
 * LP cards keep the LP rollup rules (§9.4): with gates passed and
 * requirements available they read the wrapped strategy-triggers row, so
 * LP floors and trigger states stay strategy-triggers' own. Research
 * catalogs get their triggers in Phase 10: a card with everything passing
 * is conditional with trigger_evaluated 0 until then.
 *
 * Gate inputs: 'descriptor-snapshot' rows (dims scope/template_key/
 * device_class/field_path, metrics.status[/value_json/owner]) and
 * 'structural-screen' rows (dims catalog_id/rule_id, metrics state/detail)
 * are read from ctx.datasets when present. When the descriptor-snapshot
 * dataset is absent from ctx entirely, G1/G2 fail with 'no descriptor
 * snapshot (Phase 5 pending)' — no card passes gates without descriptors.
 * Capture status is read per page from ae_page_capture_current through the
 * gateway (UNKNOWN_TABLE-tolerant → 'missing'). Signals, floors, confounds,
 * segments and the revenue join are Phase-10 wiring: ctx.gateInputs may
 * carry them (signals, floorResult, sampleGap, confoundOpen,
 * segmentReversal, revenueJoin, economicsConfirmed, reproPassed,
 * randomizedCounterfactual); defaults keep those gates passing. Cards
 * always carry attribution_label: 'incremental' only with a randomized or
 * holdout counterfactual, else 'associated' (B10).
 */

// §5.5: TD:FIX and TD:F-ROUTE are fix rows, not strategies. The Phase 1
// exit count is 311 cards per page (269 research + 1 alias + 41 LP).
const SKIP_BY_CATALOG = {
  TD: new Set(['TD:FIX', 'TD:F-ROUTE']),
};

const SITE_CATALOGS = new Set(['TI', 'TD', 'TG']);

// gate_failed values (ae_strategy_card.gate_failed). Phase 1 used
// 'descriptor' for the G1 failure; the rest follow the same word style.
const GATE_FAILED_LABELS = {
  G1: 'descriptor',
  G2: 'capture',
  G3: 'signals',
  G4: 'structure',
  G5: 'constraint',
  G6: 'floor',
  G7: 'confound',
  G8: 'segment',
  G9: 'revenue',
};

// §9.4 card rules: a missing/expired requirement blocks the card when the
// requirement is structural — the render/geometry/model layer (M codes);
// instrumentation (T), sample (H) and everything else are conditional.
const STRUCTURAL_REQUIREMENT_DOMAINS = new Set(['render']);

// LP rollup states (strategy-triggers.js) -> card verdicts (§9.4 G6).
const LP_STATE_VERDICTS = {
  triggered: 'include',
  silent: 'silent',
  below_floor: 'conditional',
  blocked: 'blocked',
};

/**
 * The page's capture status from ae_page_capture_current: 'current' when
 * the newest capture is complete on the engine's taxonomy, 'stale' when a
 * row exists otherwise, 'missing' when no row exists, the table is absent
 * (UNKNOWN_TABLE tolerance, pre-cutover clusters) or no gateway/page is
 * available (unit fixtures).
 *
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {object} page
 * @returns {Promise<'current'|'stale'|'missing'>}
 */
export async function readCaptureStatus(ctx, page) {
  if (!ctx?.gateway?.query || page == null || page.idsite == null || page.idsitehsr == null) {
    return 'missing';
  }
  /** @type {Array<object>} */
  let rows;
  try {
    rows = await ctx.gateway.query(
      `SELECT status, taxonomy_version
         FROM ${configuredDatabase()}.ae_page_capture_current
        WHERE idsite = {idsite:UInt32}
          AND idsitehsr = {idsitehsr:UInt64}
        LIMIT 1`,
      { idsite: Number(page.idsite), idsitehsr: Number(page.idsitehsr) },
      'cards:capture-status',
    );
  } catch (err) {
    if (!/UNKNOWN_TABLE|Unknown table/i.test(String(err?.message ?? err))) throw err;
    return 'missing';
  }
  const row = rows[0];
  if (!row) return 'missing';
  if (String(row.status ?? '') === 'complete' && String(row.taxonomy_version ?? '') === TAXONOMY_VERSION) {
    return 'current';
  }
  return 'stale';
}

/**
 * descriptor-snapshot dataset rows → the gate module's Map keyed
 * 'scope|template_key|device|field'. Values are the row metrics, so G5 can
 * read value_json/owner off the same entries the status rides on.
 * @param {Array<{dims: object, metrics: object}>} rows
 * @returns {Map<string, object>}
 */
function descriptorSnapshotMap(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = [row.dims.scope, row.dims.template_key, row.dims.device_class, row.dims.field_path].join('|');
    map.set(key, row.metrics ?? {});
  }
  return map;
}

/**
 * The catalog's screen verdict for G4: the first rule (in screen order)
 * that is blocked, addable or unknown; null when no rule evaluated to one
 * of those (nothing evaluable, or only present/not_evaluable rows) — the
 * gate then passes with structural_state 'present'.
 * @param {string} catalogId
 * @param {Array<{dims: object, metrics: object}>} screenRows
 * @param {Map<string, object>} rulesById
 * @returns {{state: string, ruleId: string, disposition: string, detail: string} | null}
 */
function screenResultFor(catalogId, screenRows, rulesById) {
  const rows = screenRows.filter((r) => r.dims.catalog_id === catalogId);
  for (const state of ['blocked', 'addable', 'unknown']) {
    const row = rows.find((r) => r.metrics.state === state);
    if (row) {
      const rule = rulesById.get(row.dims.rule_id);
      return {
        state,
        ruleId: row.dims.rule_id,
        disposition: rule?.disposition ?? state,
        detail: String(row.metrics.detail ?? ''),
      };
    }
  }
  return null;
}

/**
 * @param {string} catalogId
 * @param {Array<{dims: object, metrics: object}>} screenRows
 * @returns {string[]} rule ids the screen could not evaluate (cards pass
 *   them with structural_state 'present' and record them here)
 */
function unevaluatedRulesFor(catalogId, screenRows) {
  return screenRows
    .filter((r) => r.dims.catalog_id === catalogId && r.metrics.state === 'not_evaluable')
    .map((r) => r.dims.rule_id);
}

/**
 * @param {string} catalogId LP, PO, PI, PG, TI, TD or TG
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {object} page the QualifiedPage (capture status is read per page)
 * @returns {Promise<import('../../../ports/dataset.js').Dataset>}
 */
export async function buildCards(catalogId, ctx, page) {
  const bundle = loadCatalog();
  const catalog = bundle.strategies[catalogId];
  const skip = SKIP_BY_CATALOG[catalogId] ?? new Set();

  const statusRows = ctx.datasets.get('requirement-status')?.rows ?? [];
  const statusByKey = new Map(statusRows.map((r) => [r.dims.requirement_key, r.metrics.status]));
  const domainByKey = new Map(bundle.requirements.requirements.map((r) => [r.key, r.domain]));

  const triggerRows = catalogId === 'LP' ? (ctx.datasets.get('strategy-triggers')?.rows ?? []) : [];
  const triggerByStrategy = new Map(triggerRows.map((r) => [r.dims.strategy_id, r]));

  const descriptorDataset = ctx.datasets.get('descriptor-snapshot');
  // Absent dataset → null (gates fail 'no descriptor snapshot'), not an
  // empty map (which would mean: dataset ran, nothing current).
  const descriptorSnapshot = descriptorDataset ? descriptorSnapshotMap(descriptorDataset.rows ?? []) : null;
  const captureStatus = await readCaptureStatus(ctx, page);

  const screenRows = ctx.datasets.get('structural-screen')?.rows ?? [];
  const rulesById = new Map(bundle.screenRules.rules.map((r) => [r.id, r]));
  const screenResult = screenResultFor(catalogId, screenRows, rulesById);
  const gateInputs = ctx.gateInputs && typeof ctx.gateInputs === 'object' ? ctx.gateInputs : {};

  const rows = [];
  for (const strategy of catalog.strategies) {
    if (skip.has(strategy.id)) continue;
    const target = strategy.alias_of
      ? catalog.strategies.find((s) => s.id === strategy.alias_of)
      : undefined;
    const effective = target ?? strategy;
    const requirementKeys = effective.requirement_keys ?? [];
    const missing = requirementKeys.filter((key) => statusByKey.get(key) !== 'available');
    const structuralMissing = missing.filter((key) => STRUCTURAL_REQUIREMENT_DOMAINS.has(domainByKey.get(key)));
    const unevaluated = unevaluatedRulesFor(catalogId, screenRows);

    const gateEval = evaluateGates({
      strategy: effective,
      catalogId,
      inputs: {
        ...gateInputs,
        descriptorSnapshot,
        captureStatus,
        screenResult,
        requirementStatus: statusByKey,
      },
      standards: bundle.standards,
    });

    let verdict;
    let detail;
    let triggerState = '';
    let triggerEvaluated = 0;
    let gateFailed = '';
    let metric = null;
    let value = null;
    let threshold = null;

    const failure = gateEval.gates.find((g) => !g.passed) ?? null;
    if (failure) {
      // §9.4: the catalog's failure mapping decides; the trigger is never
      // evaluated on a failed gate (trigger_evaluated 0).
      const mapped = mapGateFailure(catalogId, failure.gate, bundle.standards, {
        disposition: failure.disposition,
        fieldStatus: failure.fieldStatus,
      });
      verdict = mapped.verdict;
      triggerEvaluated = mapped.triggerEvaluated;
      gateFailed = GATE_FAILED_LABELS[failure.gate] ?? failure.gate.toLowerCase();
      detail = failure.detail;
    } else if (missing.length > 0) {
      // §9.4 card rules: never silent; conditional for instrumentation or
      // sample requirements, blocked for structural ones. The codes always
      // ride in missing_requirements.
      verdict = structuralMissing.length > 0 ? 'blocked' : 'conditional';
      detail = `missing requirements: ${missing.join(', ')}`;
      gateFailed = structuralMissing.length > 0 ? 'structural_requirement' : 'requirements';
    } else if (catalogId === 'LP') {
      // LP floors and trigger states stay the wrapped strategy-triggers
      // behavior (§9.4: LP cards keep the LP rollup rules exactly).
      const triggerRow = triggerByStrategy.get(strategy.id);
      if (triggerRow) {
        verdict = LP_STATE_VERDICTS[triggerRow.metrics.state] ?? 'conditional';
        triggerEvaluated = 1;
        triggerState = triggerRow.metrics.state;
        metric = triggerRow.metrics.metric ?? null;
        value = triggerRow.metrics.value ?? null;
        threshold = triggerRow.metrics.threshold ?? null;
        detail = triggerRow.metrics.detail ?? 'LP trigger evaluated';
      } else {
        verdict = 'conditional';
        detail = 'no strategy-triggers row for this LP strategy';
        gateFailed = 'requirements';
      }
    } else {
      // All gates pass and requirements are available; triggers per
      // catalog arrive in Phase 10, so the card waits as conditional.
      verdict = 'conditional';
      detail = 'no trigger evaluation (Phase 10)';
    }

    rows.push({
      dims: {
        strategy_id: strategy.id,
        segment_key: 'all',
        ...(strategy.alias_of ? { alias_of: strategy.alias_of } : {}),
      },
      metrics: {
        catalog_id: catalogId,
        verdict,
        trigger_state: triggerState,
        trigger_evaluated: triggerEvaluated,
        missing_requirements: missing,
        gate_failed: gateFailed,
        structural_state: gateEval.structuralState,
        screen_rule_id: gateEval.screenRuleId || '',
        attribution_label: gateEval.attributionLabel,
        unevaluated_screen_rules: unevaluated,
        detail,
        floor_standard: catalogId,
        metric,
        value,
        threshold,
      },
    });
  }

  return {
    id: `cards-${catalogId.toLowerCase()}`,
    rows,
    notes: {
      cards: rows.length,
      catalog_id: catalogId,
      descriptor_snapshot_present: descriptorSnapshot != null,
      capture_status: captureStatus,
      unevaluated_screen_rules: screenRows
        .filter((r) => r.metrics.state === 'not_evaluable')
        .map((r) => `${r.dims.catalog_id}:${r.dims.rule_id}`),
    },
  };
}
