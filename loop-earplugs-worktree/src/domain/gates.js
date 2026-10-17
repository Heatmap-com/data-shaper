/**
 * The §9.4 gate pipeline (plan §9.4, Phase 5). Pure module: no SQL, no fs,
 * no catalog loading — the caller passes the strategy row, the catalog id,
 * the gate inputs and the standards object (bundle.standards). Gates are
 * evaluated in order G1..G9; the first failure is the one a card acts on.
 *
 * Inputs (all optional; defaults keep the gate honest, not silent):
 *   descriptorSnapshot: Map 'scope|template_key|device|field' → status
 *     ('current'|'expired'|'unknown') or a row-like object carrying
 *     {status, value_json?, owner?}. null/undefined means the
 *     descriptor-snapshot dataset did not run this batch: G1 and G2 fail
 *     with 'no descriptor snapshot (Phase 5 pending)' so no card passes
 *     gates without descriptors.
 *   captureStatus: 'current' passes G2; 'stale'/'missing' (or absent) fail.
 *   requirementStatus: Map key → status; read by Phase-10 predicates.
 *   screenResult: {state, ruleId, disposition?} | null. States: 'blocked'
 *     fails G4; 'addable'/'unknown' pass with that structural_state; null
 *     (no rule) passes as 'present'; 'not_evaluable' is pre-filtered by
 *     the caller and recorded on the card, not here.
 *   signals: {botShareOk, instrumentationChangeInWindow, eventValidated,
 *     experimentOverlap, promoWindow} — each defaults true; any false
 *     signal fails G3 with the signal named.
 *   floorResult / sampleGap: floorResult 'below_floor' fails G6 and names
 *     the sample gap. (LP floors stay in strategy-triggers; §9.4 G6.)
 *   confoundOpen: truthy fails G7 (exclude, exclusion_reeval).
 *   segmentReversal: truthy fails G8 (conditional, scoped to the cut).
 *   revenueJoin {confirmed} / economicsConfirmed: an explicit false fails
 *     G9 ('not confirmed') unless the strategy is a D-family fix with a
 *     deterministic-repro verdict (reproPassed), per §9.4/B9. Absent
 *     inputs mean 'not evaluated yet' and pass — Phase 10 wires the real
 *     join; default inputs make G6–G9 pass.
 *   randomizedCounterfactual: true makes the card attribution_label
 *     'incremental', otherwise 'associated' (B10).
 *
 * mapGateFailure(catalogId, gate, standards, opts) maps a failed gate to
 * the catalog's card state. G1/G2/G3 read standards.catalogs[catalogId]
 * .gates.{g1,g2,g3} ('conditional' page catalogs = stop with
 * trigger_evaluated 0, 'blocked' site catalogs); G1 on an 'unknown' field
 * reads gates.unknown_fields (B16: 'conditional' LP/PO/PI/PG,
 * 'confidence_cap' TD — verdict conditional, confidence capped by the TD
 * standard — 'unknown' TG — not a failure: the gate passes and the card
 * carries structural_state 'unknown' — 'blocked' TI). G4 maps from the
 * screen rule's disposition (blocked|addable|conditional|unknown|exclude;
 * PI's structural contradictions resolve to 'exclude'). G5/G7 → exclude;
 * G6/G8/G9 → conditional. Every mapping stops trigger evaluation.
 */

export const GATE_IDS = Object.freeze(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9']);

const PAGE_CATALOGS = new Set(['LP', 'PO', 'PI', 'PG']);

// G5 reads these constraint fields for every strategy, per descriptor
// scope (plan §9.4 G5: p13.constraints page; s31.consent + s33.fraud_policy
// store). p13/s31/s33 are operator-only fields, never bot-drafted.
const CONSTRAINT_FIELDS = Object.freeze({
  page: ['p13.constraints'],
  store: ['s31.consent', 's33.fraud_policy'],
});

// G3 signal names as they appear in card detail.
const SIGNAL_NAMES = Object.freeze({
  botShareOk: 'bot_share',
  instrumentationChangeInWindow: 'instrumentation_change',
  eventValidated: 'event_validation',
  experimentOverlap: 'experiment_overlap',
  promoWindow: 'promo_window',
});

const STRUCTURAL_RANK = Object.freeze({ blocked: 4, unknown: 3, addable: 2, present: 1, '': 0 });

/**
 * The descriptor scope a strategy reads: page strategies read the page
 * descriptor, site (surface) strategies read the store descriptor
 * (BASE-PAGE 'page descriptor current (gate)' vs BASE-SITE 'store
 * descriptor current (gate)').
 * @param {object} strategy @param {string} catalogId @returns {'page'|'store'}
 */
function descriptorScope(strategy, catalogId) {
  const scope = strategy?.scope ?? (PAGE_CATALOGS.has(catalogId) ? 'page' : 'site');
  return scope === 'page' ? 'page' : 'store';
}

/** @param {unknown} entry @returns {string} */
function statusOf(entry) {
  return typeof entry === 'string' ? entry : String(entry?.status ?? 'unknown');
}

/** @param {unknown} entry @returns {unknown} */
function valueOf(entry) {
  return typeof entry === 'object' && entry !== null ? entry.value_json : undefined;
}

/** @param {unknown} entry @returns {string} */
function ownerOf(entry) {
  return typeof entry === 'object' && entry !== null ? String(entry.owner ?? '') : '';
}

/**
 * Descriptor refs use TI numbering for store fields ('F16' means store
 * field s16, §5.4); full paths pass through. Returns the match prefix.
 * @param {string} ref
 */
function fieldPrefix(ref) {
  const f = /^F(\d{2})$/.exec(ref);
  return f ? `s${f[1]}` : String(ref).split('.')[0];
}

/**
 * @param {Map<string, *> | null | undefined} snapshot
 * @param {string} scope
 * @returns {Array<{field: string, status: string, value: unknown, owner: string}>}
 */
function snapshotRows(snapshot, scope) {
  if (!snapshot) return [];
  const rows = [];
  for (const [key, entry] of snapshot) {
    const parts = String(key).split('|');
    if ((parts[0] ?? '') !== scope) continue;
    rows.push({
      field: parts[3] ?? '',
      status: statusOf(entry),
      value: valueOf(entry),
      owner: ownerOf(entry),
    });
  }
  return rows;
}

/** @param {object} standards @param {string} catalogId @returns {string} */
function unknownFieldMapping(standards, catalogId) {
  const gates = standards?.catalogs?.[catalogId]?.gates ?? {};
  return gates.unknown_fields ?? (PAGE_CATALOGS.has(catalogId) ? 'conditional' : 'blocked');
}

/**
 * G1 — descriptor current. A cited field that is 'unknown' (low-confidence
 * bot draft, B16) counts as NOT current, except TG, where unknown fields
 * pass the gate and the card carries structural_state 'unknown'. Fails
 * when any cited field is expired, or when the scope snapshot has no
 * 'current' fields at all.
 */
function evalDescriptorGate(strategy, catalogId, inputs, standards) {
  const scope = descriptorScope(strategy, catalogId);
  if (inputs.descriptorSnapshot == null) {
    return { failed: true, detail: 'no descriptor snapshot (Phase 5 pending)' };
  }
  const rows = snapshotRows(inputs.descriptorSnapshot, scope);
  const refs = Array.isArray(strategy?.descriptor_refs) ? strategy.descriptor_refs : [];
  /** @type {{field: string} | null} */
  let unknownField = null;
  for (const ref of refs) {
    const prefix = fieldPrefix(ref);
    const matching = rows.filter((r) => r.field === String(ref) || r.field.split('.')[0] === prefix);
    if (matching.some((r) => r.status === 'current')) continue;
    const expired = matching.find((r) => r.status === 'expired');
    if (expired) return { failed: true, detail: `descriptor field ${expired.field} expired` };
    const unknown = matching.find((r) => r.status === 'unknown');
    if (unknown && unknownField == null) unknownField = { field: unknown.field };
    if (!unknown && matching.length === 0) {
      return { failed: true, detail: `descriptor field ${prefix} missing from ${scope} snapshot` };
    }
  }
  const hasCurrent = rows.some((r) => r.status === 'current');
  const unknownOnly = !hasCurrent && (unknownField != null || rows.some((r) => r.status === 'unknown'));
  // TG (B16 'unknown'): unknown (low-confidence) fields are not a failure;
  // the card carries structural_state 'unknown' instead.
  if (unknownOnly && unknownFieldMapping(standards, catalogId) === 'unknown') {
    return {
      failed: false,
      detail: `descriptor field ${(unknownField ?? { field: `${scope} descriptor` }).field} unknown; structural state 'unknown'`,
      structuralState: 'unknown',
    };
  }
  if (!hasCurrent) {
    return { failed: true, detail: `no current fields in ${scope} descriptor snapshot` };
  }
  if (unknownField) {
    const capped = unknownFieldMapping(standards, catalogId) === 'confidence_cap';
    return {
      failed: true,
      fieldStatus: 'unknown',
      detail: `descriptor field ${unknownField.field} unknown (low confidence)${capped ? '; confidence capped' : ''}`,
    };
  }
  return { failed: false, detail: `${scope} descriptor current` };
}

/** G2 — capture current. */
function evalCaptureGate(inputs) {
  if (inputs.descriptorSnapshot == null) {
    return { failed: true, detail: 'no descriptor snapshot (Phase 5 pending)' };
  }
  const status = inputs.captureStatus ?? 'missing';
  if (status === 'current') return { failed: false, detail: 'capture current' };
  return { failed: true, detail: `capture ${status}` };
}

/** G3 — signals valid. */
function evalSignalsGate(inputs) {
  const signals = {
    botShareOk: true,
    instrumentationChangeInWindow: true,
    eventValidated: true,
    experimentOverlap: true,
    promoWindow: true,
    ...(inputs.signals ?? {}),
  };
  const failed = Object.keys(SIGNAL_NAMES).filter((key) => signals[key] === false);
  if (failed.length === 0) return { failed: false, detail: 'signals valid' };
  return { failed: true, detail: `signal invalid: ${failed.map((key) => SIGNAL_NAMES[key]).join(', ')}` };
}

/** G4 — structure permits. */
function evalStructureGate(screenResult) {
  if (!screenResult) return { failed: false, structuralState: 'present', detail: 'structural_state present (no screen rule)' };
  const { state, ruleId, detail } = screenResult;
  if (state === 'blocked') {
    return {
      failed: true,
      structuralState: 'blocked',
      disposition: screenResult.disposition ?? 'blocked',
      detail: `structural_state blocked by ${ruleId}${detail ? `: ${detail}` : ''}`,
    };
  }
  if (state === 'addable') {
    return { failed: false, structuralState: 'addable', detail: `structural_state addable (${ruleId})` };
  }
  if (state === 'unknown') {
    return { failed: false, structuralState: 'unknown', detail: `structural_state unknown (${ruleId})` };
  }
  return { failed: false, structuralState: 'present', detail: `structural_state present (${ruleId})` };
}

/**
 * @param {unknown} raw value_json as stored (string or parsed)
 * @returns {unknown} parsed value; null when empty/'null'/unparseable
 */
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

/** A parsed value implies a constraint only as a non-empty object/array. */
function impliesConstraint(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

/** G5 — no constraint forbids. */
function evalConstraintGate(strategy, catalogId, inputs) {
  const scope = descriptorScope(strategy, catalogId);
  if (inputs.descriptorSnapshot == null) {
    return { failed: false, detail: 'no constraint read (no descriptor snapshot)' };
  }
  const rows = snapshotRows(inputs.descriptorSnapshot, scope);
  for (const field of CONSTRAINT_FIELDS[scope] ?? []) {
    for (const row of rows.filter((r) => r.field === field)) {
      if (impliesConstraint(parseJsonValue(row.value))) {
        const owner = row.owner ? ` (owner ${row.owner})` : '';
        return { failed: true, detail: `constraint forbids: ${field}${owner}` };
      }
    }
  }
  return { failed: false, detail: 'no constraint forbids' };
}

/**
 * Evaluate the nine §9.4 gates for one strategy. Returns one result per
 * gate in evaluation order; exactly the first failed gate carries the
 * mapping context (disposition for G4, fieldStatus for G1) the writer
 * needs for mapGateFailure. Also returns the card-level fields the
 * structural state, screen rule and attribution label ride in.
 *
 * @param {object} args
 * @param {object} args.strategy catalog strategy row (descriptor_refs, scope, family)
 * @param {string} args.catalogId LP, PO, PI, PG, TI, TD or TG
 * @param {object} [args.inputs] gate inputs (see module docstring)
 * @param {object} [args.standards] bundle.standards (catalogs[catalogId].gates)
 * @returns {{gates: Array<{gate: string, passed: boolean, detail: string, disposition?: string, fieldStatus?: string}>,
 *   firstFailure: {gate: string, detail: string} | null,
 *   structuralState: string, screenRuleId: string, attributionLabel: string}}
 */
export function evaluateGates({ strategy, catalogId, inputs = {}, standards = {} }) {
  const g1 = evalDescriptorGate(strategy, catalogId, inputs, standards);
  const g2 = evalCaptureGate(inputs);
  const g3 = evalSignalsGate(inputs);
  const g4 = evalStructureGate(inputs.screenResult ?? null);
  const g5 = evalConstraintGate(strategy, catalogId, inputs);

  const family = String(strategy?.family ?? '');
  const dFamilyRepro = family.startsWith('D') && inputs.reproPassed === true;
  const joinNegative = inputs.revenueJoin ? inputs.revenueJoin.confirmed === false : false;
  const econNegative = inputs.economicsConfirmed === false;
  const g9 = joinNegative || econNegative
    ? dFamilyRepro
      ? { failed: false, detail: 'revenue join not required (D-family deterministic repro)' }
      : { failed: true, detail: 'revenue join not confirmed' }
    : { failed: false, detail: 'revenue join not evaluated (Phase 10 wiring)' };

  const g6 = inputs.floorResult === 'below_floor'
    ? { failed: true, detail: `below floor${inputs.sampleGap != null ? `: sample gap ${inputs.sampleGap}` : ''}` }
    : { failed: false, detail: 'trigger floor not evaluated (Phase 10 wiring)' };
  const g7 = inputs.confoundOpen
    ? { failed: true, detail: `confound open: ${inputs.confoundOpen}; exclusion reevaluated next window` }
    : { failed: false, detail: 'no open confound' };
  const g8 = inputs.segmentReversal
    ? { failed: true, detail: `segment reversal: ${inputs.segmentReversal}` }
    : { failed: false, detail: 'holds in segment cuts' };

  /** @type {Array<{gate: string, passed: boolean, detail: string, disposition?: string, fieldStatus?: string}>} */
  const gates = [
    { gate: 'G1', passed: !g1.failed, detail: g1.detail, ...(g1.fieldStatus ? { fieldStatus: g1.fieldStatus } : {}) },
    { gate: 'G2', passed: !g2.failed, detail: g2.detail },
    { gate: 'G3', passed: !g3.failed, detail: g3.detail },
    { gate: 'G4', passed: !g4.failed, detail: g4.detail, ...(g4.disposition ? { disposition: g4.disposition } : {}) },
    { gate: 'G5', passed: !g5.failed, detail: g5.detail },
    { gate: 'G6', passed: !g6.failed, detail: g6.detail },
    { gate: 'G7', passed: !g7.failed, detail: g7.detail },
    { gate: 'G8', passed: !g8.failed, detail: g8.detail },
    { gate: 'G9', passed: !g9.failed, detail: g9.detail },
  ];

  const first = gates.find((gate) => !gate.passed) ?? null;
  const structuralState = [g4.structuralState ?? 'present', g1.structuralState ?? ''].sort(
    (a, b) => (STRUCTURAL_RANK[b] ?? 0) - (STRUCTURAL_RANK[a] ?? 0),
  )[0];

  return {
    gates,
    firstFailure: first ? { gate: first.gate, detail: first.detail } : null,
    structuralState: structuralState || 'present',
    screenRuleId: inputs.screenResult?.ruleId ?? '',
    attributionLabel: inputs.randomizedCounterfactual ? 'incremental' : 'associated',
  };
}

/**
 * Map a failed gate to the catalog's card state (plan §9.4 failure column
 * + standards.json gates block, Appendix B B16).
 *
 * @param {string} catalogId
 * @param {string} gate 'G1'..'G9'
 * @param {object} [standards] bundle.standards
 * @param {object} [opts]
 * @param {string} [opts.disposition] screen rule disposition (G4)
 * @param {string} [opts.fieldStatus] 'unknown' when G1 failed on an
 *   unknown (low-confidence) field rather than an expired one
 * @returns {{verdict: string, triggerEvaluated: number}}
 */
export function mapGateFailure(catalogId, gate, standards = {}, opts = {}) {
  const gates = standards?.catalogs?.[catalogId]?.gates ?? {};
  const scopeDefault = PAGE_CATALOGS.has(catalogId) ? 'conditional' : 'blocked';
  /** @param {string} key @param {string} [fallback] @returns {{verdict: string, triggerEvaluated: number}} */
  const mapped = (key, fallback) => {
    const mapping = gates[key] ?? (fallback ? gates[fallback] : undefined) ?? scopeDefault;
    return { verdict: mapping === 'blocked' ? 'blocked' : 'conditional', triggerEvaluated: 0 };
  };
  switch (gate) {
    case 'G1':
      if (opts.fieldStatus === 'unknown') {
        // B16: 'conditional' (LP/PO/PI/PG), 'confidence_cap' (TD — verdict
        // conditional, the TD standard caps confidence), 'blocked' (TI).
        // TG ('unknown') never fails G1, so it does not reach this map.
        const mapping = gates.unknown_fields ?? gates.g1 ?? scopeDefault;
        return { verdict: mapping === 'blocked' ? 'blocked' : 'conditional', triggerEvaluated: 0 };
      }
      return mapped('g1');
    case 'G2':
      return mapped('g2', 'g1');
    case 'G3':
      return mapped('g3', 'g1');
    case 'G4': {
      const disposition = opts.disposition ?? 'blocked';
      if (disposition === 'exclude') return { verdict: 'exclude', triggerEvaluated: 0 };
      if (disposition === 'conditional' || disposition === 'addable') {
        return { verdict: disposition, triggerEvaluated: 0 };
      }
      return { verdict: 'blocked', triggerEvaluated: 0 };
    }
    case 'G5':
    case 'G7':
      return { verdict: 'exclude', triggerEvaluated: 0 };
    case 'G6':
    case 'G8':
    case 'G9':
      return { verdict: 'conditional', triggerEvaluated: 0 };
    default:
      throw new Error(`mapGateFailure: unknown gate ${gate}`);
  }
}
