import { daysBetween } from './lifecycle.js';
import { meanDifference, srmPvalue, twoProportion } from './stats.js';

/**
 * Fact rows to ae_experiment_row, and ae_experiment_row to the per-arm
 * readout the dataset returns.
 */

/**
 * @typedef {Object} Plan one analyzed experiment
 * @property {number} index position in the query's arrays
 * @property {object} exp normalized experiment (normalize.js) with descriptor fields
 * @property {Array<{arm: string, isControl: boolean, allocation: number | null}>} arms analyzed arms, by query index
 * @property {string} start YYYY-MM-DD
 * @property {string} end YYYY-MM-DD
 */

/**
 * @param {object[]} raw query rows
 * @param {Plan[]} plans
 * @param {{batchId: string, idsite: number, kind: 'experiment' | 'page' | 'section' | 'element', elements?: Map<string, {arm: string, elementClass: string}>}} opts
 *   elements is keyed `{exp}|{normalized selector}`
 * @returns {import('../ports/persistence.js').AeExperimentAnalysisRow[]}
 */
export function toExperimentRows(raw, plans, opts) {
  const byIndex = new Map(plans.map((p) => [p.index, p]));
  const kind = opts.kind;
  /** @type {object[]} */
  const rows = [];
  for (const r of raw) {
    const plan = byIndex.get(Number(r.exp));
    if (!plan) continue;
    const basis = kind === 'experiment' || kind === 'section' ? String(r.basis) : kind === 'element' ? 'clicked' : 'exposed';
    const arm = basis === 'multi_arm' ? null : plan.arms[Number(r.arm_index)];
    if (basis !== 'multi_arm' && !arm) continue;
    const selector = kind === 'element' ? String(r.selector) : '';
    let elementClass = '';
    if (kind === 'element') {
      const element = opts.elements?.get(`${plan.index}|${selector}`);
      if (element?.arm && element.arm !== arm.arm) continue;
      elementClass = element?.elementClass ?? '';
    }
    const day = String(r.day);
    /** @type {Record<string, unknown>} */
    const metrics = { row_kind: kind, revenue_sq: Number(r.revenue_sq ?? 0) };
    if ((kind === 'section' || kind === 'element') && r.section_path) metrics.section_path = parsePath(r.section_path);
    rows.push({
      batchId: opts.batchId,
      idsite: opts.idsite,
      experimentKey: plan.exp.key,
      arm: arm?.arm ?? '',
      isControl: arm?.isControl ?? false,
      scope: plan.exp.scope,
      basis,
      idsitehsr: kind === 'page' ? Number(r.idsitehsr ?? 0) : 0,
      section: kind === 'section' || kind === 'element' ? String(r.section ?? '') : '',
      selector,
      elementClass,
      viewportType: String(r.viewport_type),
      segment: kind === 'experiment' ? String(r.segment) : 'all',
      segmentValue: kind === 'experiment' ? String(r.segment_value) : 'all',
      day,
      dayIndex: Math.max(0, daysBetween(plan.start, day)),
      sessions: Number(r.sessions ?? 0),
      buyers: Number(r.buyers ?? 0),
      orders: Number(r.orders ?? 0),
      revenue: round2(Number(r.revenue ?? 0)),
      clicks: Number(r.clicks ?? 0),
      progressed: Number(r.progressed ?? 0),
      metrics,
    });
  }
  return rows;
}

/** section_path is stored as a JSON array of names, outermost first. @param {unknown} raw */
function parsePath(raw) {
  try {
    const path = JSON.parse(String(raw));
    return Array.isArray(path) ? path.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Per-arm totals over the active period for one basis and viewport.
 * @param {object[]} rows experiment-level rows of one experiment
 * @param {string} basis
 * @param {string} viewport
 */
function totals(rows, basis, viewport) {
  /** @type {Map<string, {sessions: number, buyers: number, orders: number, revenue: number, revenueSq: number, progressed: number}>} */
  const byArm = new Map();
  for (const row of rows) {
    if (row.basis !== basis || row.viewportType !== viewport || row.segment !== 'all' || row.idsitehsr !== 0) continue;
    const t = byArm.get(row.arm) ?? { sessions: 0, buyers: 0, orders: 0, revenue: 0, revenueSq: 0, progressed: 0 };
    t.sessions += row.sessions;
    t.buyers += row.buyers;
    t.orders += row.orders;
    t.revenue += row.revenue;
    t.revenueSq += row.metrics?.revenue_sq ?? 0;
    t.progressed += row.progressed;
    byArm.set(row.arm, t);
  }
  return byArm;
}

/**
 * Readout rows for one analyzed experiment: one per (arm, basis). The SRM
 * test reads the assigned basis on every device. Lifts and p-values are
 * against the control on the same basis and viewport.
 * @param {Plan} plan
 * @param {object[]} rows the experiment's ae_experiment_row rows
 */
export function readoutRows(plan, rows) {
  const exp = plan.exp;
  const viewport = exp.deviceScope || 'all';
  const assignedAll = totals(rows, 'assigned', 'all');
  const declared = plan.arms.filter((a) => a.allocation != null).map((a) => ({ arm: a.arm, allocation: a.allocation }));
  const observed = new Map(plan.arms.map((a) => [a.arm, assignedAll.get(a.arm)?.sessions ?? 0]));
  // With no allocation declared anywhere, test against an even split; the
  // basis says which one the p-value assumes.
  const srmBasis = declared.length === plan.arms.length ? 'declared' : declared.length === 0 ? 'assumed_equal' : null;
  const srm = srmBasis === 'declared'
    ? srmPvalue(observed, declared)
    : srmBasis === 'assumed_equal'
      ? srmPvalue(observed, plan.arms.map((a) => ({ arm: a.arm, allocation: 1 })))
      : null;
  const multiArm = rows
    .filter((r) => r.basis === 'multi_arm' && r.viewportType === 'all' && r.segment === 'all')
    .reduce((sum, r) => sum + r.sessions, 0);
  const assignedTotal = [...observed.values()].reduce((sum, n) => sum + n, 0);
  const control = plan.arms.find((a) => a.isControl);

  const out = [];
  const bases = exp.exposureRule === 'pages' || exp.exposureRule === 'templates' ? ['assigned', 'exposed'] : ['assigned'];
  for (const basis of bases) {
    const t = totals(rows, basis, viewport);
    const c = control ? t.get(control.arm) : undefined;
    for (const arm of plan.arms) {
      const a = t.get(arm.arm) ?? { sessions: 0, buyers: 0, orders: 0, revenue: 0, revenueSq: 0, progressed: 0 };
      const vsControl = c && !arm.isControl;
      const cvr = vsControl ? twoProportion(a.buyers, a.sessions, c.buyers, c.sessions) : null;
      const rps = vsControl
        ? meanDifference({ n: a.sessions, sum: a.revenue, sumSq: a.revenueSq }, { n: c.sessions, sum: c.revenue, sumSq: c.revenueSq })
        : null;
      out.push({
        dims: { experiment_key: exp.key, arm: arm.arm, basis, viewport_type: viewport, bot_filter: 'portal' },
        metrics: {
          name: exp.name,
          partner: exp.partner,
          arm_label: arm.label,
          is_control: arm.isControl ? 1 : 0,
          status: exp.status,
          scope: exp.scope,
          exposure_rule: exp.exposureRule,
          analysis_start: plan.start,
          analysis_end: plan.end,
          days: daysBetween(plan.start, plan.end) + 1,
          sessions: a.sessions,
          assigned_share: assignedTotal > 0 ? round4((observed.get(arm.arm) ?? 0) / assignedTotal) : null,
          declared_allocation: arm.allocation,
          srm_pvalue: srm == null ? null : round6(srm),
          srm_basis: srmBasis,
          multi_arm_visits: multiArm,
          buyers: a.buyers,
          orders: a.orders,
          revenue: round2(a.revenue),
          cvr: a.sessions > 0 ? round6(a.buyers / a.sessions) : null,
          rps: a.sessions > 0 ? round4(a.revenue / a.sessions) : null,
          aov: a.orders > 0 ? round2(a.revenue / a.orders) : null,
          checkout_rate: a.sessions > 0 ? round6(a.progressed / a.sessions) : null,
          cvr_lift: cvr?.lift == null ? null : round4(cvr.lift),
          cvr_pvalue: cvr?.p == null ? null : round6(cvr.p),
          rps_lift: rps?.lift == null ? null : round4(rps.lift),
          rps_pvalue: rps?.p == null ? null : round6(rps.p),
        },
      });
    }
  }
  return out;
}

/**
 * Rate comparisons for the visits the section tracker captured, below this
 * capture or seen-rate p-value, are not read as treatment effects.
 */
export const BALANCE_P = 0.05;

/**
 * Rollup readout for one analyzed experiment. Per arm, a `section_captured`
 * row: the share of assigned visits the section tracker captured, tested
 * against control, because every section rate divides by it. Per (section,
 * arm), a `section` row: the seen and click rates on the captured base with
 * lift against control, and the outcomes of the visits that saw it.
 * seen_outcomes_comparable is 0 when capture or the seen rate differs from
 * control: the visits that saw the section are then not the same kind of
 * visitor in both arms.
 * @param {Plan} plan
 * @param {object[]} rows the experiment's ae_experiment_row rows
 * @param {Map<string, string>} [zoneRoles] operator zone section -> role
 */
export function sectionReadoutRows(plan, rows, zoneRoles = new Map()) {
  const exp = plan.exp;
  const viewport = exp.deviceScope || 'all';
  const captured = sumBy(rows, 'section_captured', viewport, () => '').get('');
  if (!captured) return [];
  const assigned = totals(rows, 'assigned', viewport);
  const control = plan.arms.find((a) => a.isControl);
  const capOf = (arm) => captured.get(arm) ?? emptyTotals();
  const asgOf = (arm) => assigned.get(arm)?.sessions ?? 0;

  const out = [];
  /** @type {Map<string, number | null>} */
  const captureP = new Map();
  for (const arm of plan.arms) {
    const cap = capOf(arm.arm);
    const vsControl = control && !arm.isControl;
    const test = vsControl ? twoProportion(cap.sessions, asgOf(arm.arm), capOf(control.arm).sessions, asgOf(control.arm)) : null;
    captureP.set(arm.arm, test?.p ?? null);
    out.push({
      dims: { experiment_key: exp.key, arm: arm.arm, basis: 'section_captured', viewport_type: viewport, bot_filter: 'portal' },
      metrics: {
        ...readoutHead(plan, arm),
        sessions: cap.sessions,
        assigned_sessions: asgOf(arm.arm),
        capture_rate: rate(cap.sessions, asgOf(arm.arm)),
        capture_lift: test?.lift == null ? null : round4(test.lift),
        capture_pvalue: test?.p == null ? null : round6(test.p),
        buyers: cap.buyers,
        cvr: rate(cap.buyers, cap.sessions),
        rps: cap.sessions > 0 ? round4(cap.revenue / cap.sessions) : null,
      },
    });
  }

  const seen = sumBy(rows, 'section_seen', viewport, (r) => r.section);
  const clicked = sumBy(rows, 'section_clicked', viewport, (r) => r.section);
  const paths = sectionPaths(rows);
  const sections = [...new Set([...seen.keys(), ...clicked.keys()])]
    .sort((a, b) => armTotal(seen.get(b)) - armTotal(seen.get(a)) || a.localeCompare(b));
  for (const section of sections) {
    const seenBy = seen.get(section) ?? new Map();
    const clickedBy = clicked.get(section) ?? new Map();
    for (const arm of plan.arms) {
      const s = seenBy.get(arm.arm) ?? emptyTotals();
      const k = clickedBy.get(arm.arm) ?? emptyTotals();
      const base = capOf(arm.arm).sessions;
      const vsControl = control && !arm.isControl;
      const cs = vsControl ? seenBy.get(control.arm) ?? emptyTotals() : null;
      const ck = vsControl ? clickedBy.get(control.arm) ?? emptyTotals() : null;
      const cBase = vsControl ? capOf(control.arm).sessions : 0;
      const seenTest = vsControl ? twoProportion(s.sessions, base, cs.sessions, cBase) : null;
      const clickTest = vsControl ? twoProportion(k.sessions, base, ck.sessions, cBase) : null;
      const cvrTest = vsControl ? twoProportion(s.buyers, s.sessions, cs.buyers, cs.sessions) : null;
      const capP = captureP.get(arm.arm);
      out.push({
        dims: { experiment_key: exp.key, arm: arm.arm, basis: 'section', section, viewport_type: viewport, bot_filter: 'portal' },
        metrics: {
          ...readoutHead(plan, arm),
          section_path: paths.get(section) ?? [section],
          zone_role: zoneRoles.get(section) ?? '',
          base_visits: base,
          seen_visits: s.sessions,
          seen_rate: rate(s.sessions, base),
          seen_rate_lift: lift(seenTest),
          seen_rate_pvalue: pvalue(seenTest),
          clicked_visits: k.sessions,
          click_rate: rate(k.sessions, base),
          click_rate_lift: lift(clickTest),
          click_rate_pvalue: pvalue(clickTest),
          seen_buyers: s.buyers,
          seen_revenue: round2(s.revenue),
          seen_cvr: rate(s.buyers, s.sessions),
          seen_rps: s.sessions > 0 ? round4(s.revenue / s.sessions) : null,
          seen_cvr_lift: lift(cvrTest),
          seen_cvr_pvalue: pvalue(cvrTest),
          capture_pvalue: capP == null ? null : round6(capP),
          seen_outcomes_comparable: vsControl
            ? ((capP ?? 1) >= BALANCE_P && (seenTest?.p ?? 1) >= BALANCE_P ? 1 : 0)
            : null,
        },
      });
    }
  }
  return out;
}

/**
 * Element readout for one analyzed experiment: per (selector, arm), the
 * share of assigned visits that clicked it, with lift against control, and
 * the outcomes of the clicking visits. Clicks come from every visit, not
 * the section sample, so the base is the arm's assigned visits.
 * @param {Plan} plan
 * @param {object[]} rows the experiment's ae_experiment_row rows
 */
export function elementReadoutRows(plan, rows) {
  const exp = plan.exp;
  const viewport = exp.deviceScope || 'all';
  const bySelector = sumBy(rows, 'clicked', viewport, (r) => r.selector);
  if (bySelector.size === 0) return [];
  const assigned = totals(rows, 'assigned', viewport);
  const control = plan.arms.find((a) => a.isControl);
  /** @type {Map<string, {section: string, path: string[], elementClass: string}>} */
  const meta = new Map();
  for (const row of rows) {
    if (row.basis !== 'clicked' || meta.has(row.selector)) continue;
    meta.set(row.selector, { section: row.section ?? '', path: row.metrics?.section_path ?? [], elementClass: row.elementClass ?? '' });
  }
  const selectors = [...bySelector.keys()]
    .sort((a, b) => armTotal(bySelector.get(b)) - armTotal(bySelector.get(a)) || a.localeCompare(b));
  const out = [];
  for (const selector of selectors) {
    const byArm = bySelector.get(selector);
    const m = meta.get(selector);
    for (const arm of plan.arms) {
      const e = byArm.get(arm.arm) ?? emptyTotals();
      const base = assigned.get(arm.arm)?.sessions ?? 0;
      const vsControl = control && !arm.isControl;
      const c = vsControl ? byArm.get(control.arm) ?? emptyTotals() : null;
      const cBase = vsControl ? assigned.get(control.arm)?.sessions ?? 0 : 0;
      const clickTest = vsControl ? twoProportion(e.sessions, base, c.sessions, cBase) : null;
      const cvrTest = vsControl ? twoProportion(e.buyers, e.sessions, c.buyers, c.sessions) : null;
      out.push({
        dims: { experiment_key: exp.key, arm: arm.arm, basis: 'element', selector, section: m?.section ?? '', viewport_type: viewport, bot_filter: 'portal' },
        metrics: {
          ...readoutHead(plan, arm),
          element_class: m?.elementClass ?? '',
          section_path: m?.path ?? [],
          base_visits: base,
          clicked_visits: e.sessions,
          clicks: e.clicks,
          click_rate: rate(e.sessions, base),
          click_rate_lift: lift(clickTest),
          click_rate_pvalue: pvalue(clickTest),
          clicks_per_clicker: e.sessions > 0 ? round4(e.clicks / e.sessions) : null,
          clicked_buyers: e.buyers,
          clicked_cvr: rate(e.buyers, e.sessions),
          clicked_rps: e.sessions > 0 ? round4(e.revenue / e.sessions) : null,
          clicked_cvr_lift: lift(cvrTest),
          clicked_cvr_pvalue: pvalue(cvrTest),
        },
      });
    }
  }
  return out;
}

/** @param {Plan} plan @param {Plan['arms'][number] & {label?: string}} arm */
function readoutHead(plan, arm) {
  return {
    name: plan.exp.name,
    partner: plan.exp.partner,
    arm_label: arm.label,
    is_control: arm.isControl ? 1 : 0,
    status: plan.exp.status,
    analysis_start: plan.start,
    analysis_end: plan.end,
  };
}

function emptyTotals() {
  return { sessions: 0, buyers: 0, orders: 0, revenue: 0, revenueSq: 0, progressed: 0, clicks: 0 };
}

/**
 * key -> arm -> totals for one basis and viewport.
 * @param {object[]} rows
 * @param {string} basis
 * @param {string} viewport
 * @param {(row: object) => string} keyOf
 */
function sumBy(rows, basis, viewport, keyOf) {
  /** @type {Map<string, Map<string, ReturnType<typeof emptyTotals>>>} */
  const out = new Map();
  for (const row of rows) {
    if (row.basis !== basis || row.viewportType !== viewport) continue;
    const key = keyOf(row);
    if (!out.has(key)) out.set(key, new Map());
    const byArm = out.get(key);
    const t = byArm.get(row.arm) ?? emptyTotals();
    t.sessions += row.sessions;
    t.buyers += row.buyers;
    t.orders += row.orders;
    t.revenue += row.revenue;
    t.revenueSq += row.metrics?.revenue_sq ?? 0;
    t.progressed += row.progressed;
    t.clicks += row.clicks;
    byArm.set(row.arm, t);
  }
  return out;
}

/** @param {object[]} rows */
function sectionPaths(rows) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const row of rows) {
    if (row.section && !out.has(row.section) && Array.isArray(row.metrics?.section_path) && row.metrics.section_path.length > 0) {
      out.set(row.section, row.metrics.section_path);
    }
  }
  return out;
}

/** @param {Map<string, {sessions: number}> | undefined} byArm */
function armTotal(byArm) {
  let sum = 0;
  for (const t of byArm?.values() ?? []) sum += t.sessions;
  return sum;
}

/** @param {number} x @param {number} n */
function rate(x, n) {
  return n > 0 ? round6(x / n) : null;
}

/** @param {{lift: number | null} | null} test */
function lift(test) {
  return test?.lift == null ? null : round4(test.lift);
}

/** @param {{p: number | null} | null} test */
function pvalue(test) {
  return test?.p == null ? null : round6(test.p);
}

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/** @param {number} n */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/** @param {number} n */
function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
