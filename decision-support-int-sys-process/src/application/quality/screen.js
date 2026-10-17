import { createHash } from 'node:crypto';
import { decisionsFor } from '../../domain/quality/decisions.js';
import { IMPACT_UNITS, impactOf, memberKey, renderQuestion, rowKeyOf, splitByDecisions, totalsOf } from '../../domain/quality/findings.js';
import { checkPeriod, periodParams } from '../../domain/shaping/period.js';
import { qualityOrdersSql } from '../../enrichment/quality-sql.js';
import { MAX_CELLS, NO_EXCLUSIONS, shapeSql } from '../../enrichment/shape-sql.js';
import { planGroups } from '../../enrichment/segmentation-sql.js';

/**
 * @typedef {import('../../domain/quality/findings.js').FindingStatus} FindingStatus
 * @typedef {Object} Finding
 * @property {string} id                   stable for the site, screen, and members
 * @property {string} screen
 * @property {string} label
 * @property {{kind: 'orders' | 'groups', by?: string}} subject
 * @property {string[]} members            member keys (order:<id>, group:<attribute>=<value>)
 * @property {string} reason
 * @property {Record<string, number | string>} values
 * @property {Record<string, string>} units
 * @property {import('../../ports/quality.js').Impact} impact
 * @property {FindingStatus} status
 * @property {'exclude' | 'include'} disposition   what this build applied
 * @property {'exclude' | 'include'} proposed
 * @property {'order' | 'session'} scope
 * @property {{adapter: string, ask: boolean, why: string} | null} triage
 * @property {object | null} decision      the person's decision, when decided
 * @property {string} question
 *
 * @typedef {Object} ScreenRun
 * @property {string} id
 * @property {string} label
 * @property {string} purpose
 * @property {string} origin
 * @property {object} subject
 * @property {{adapter: string, params: Record<string, unknown>}} method
 * @property {{adapter: string, params: Record<string, unknown>}} triage
 * @property {object} dispositions
 * @property {import('../../domain/quality/screens.js').Provenance[]} layers
 * @property {Record<string, number | string>} stats
 * @property {import('../../ports/quality.js').SubjectTotals | null} totals
 * @property {string | null} skipped
 * @property {object[]} reprocessed
 * @property {string[]} findings
 *
 * @typedef {Object} QualityResult
 * @property {ScreenRun[]} screens
 * @property {Array<{id: string, layer: string}>} off
 * @property {Finding[]} findings
 * @property {{orders: string[], visits: string[], conditions: object[], attributes: import('../../domain/shaping/attributes.js').Attribute[]}} exclusions
 * @property {{start: string, end: string}} window
 */

/** The period every subject query reads: the whole query window as one period. */
const WINDOW = checkPeriod({ grain: 'window' }).spec;

/** A short id for a finding: the site, the screen, and the sorted members. */
export function findingId(idsite, screen, members) {
  return `q_${createHash('sha1').update(`${idsite}|${screen}|${[...members].sort().join('\n')}`).digest('hex').slice(0, 12)}`;
}

/**
 * A cache of subject rows for one run, keyed by site, window, and subject,
 * so the requests of a set screen the same rows once.
 */
export function subjectCache() {
  return new Map();
}

/**
 * Reads one subject's rows: orders, or one attribute's values.
 * @returns {Promise<{rows: Array<Record<string, any>>, skipped: string | null}>}
 */
async function readSubject(subject, plan, { gateway, attributes, visitColumns, cache }) {
  const window = plan.queryWindow;
  const key = `${plan.idsite}|${window.start}|${window.end}|${subject.kind}|${subject.by ?? ''}`;
  if (cache.has(key)) return cache.get(key);
  const params = { idsite: plan.idsite, w0: window.start, w1: window.end, ...periodParams(WINDOW, window) };
  const pending = (async () => {
    if (subject.kind === 'orders') {
      const rows = await gateway.query(qualityOrdersSql(WINDOW), params, `shape:quality:${plan.id}:orders`);
      return { rows: rows.map((row) => ({ key: String(row.idorder), idvisit: String(row.idvisit), revenue: Number(row.revenue) || 0 })), skipped: null };
    }
    const attr = attributes.get(subject.by);
    if (!attr) return { rows: [], skipped: `no attribute "${subject.by}" for idsite ${plan.idsite}; declare it in the site's attributes.json` };
    if (!attr.inQuery) return { rows: [], skipped: `${subject.by} is a lookup attribute; a screen groups by an attribute the query computes` };
    if (attr.kind === 'visit') {
      const columns = await visitColumns();
      if (!columns.has(attr.column)) return { rows: [], skipped: `udp_hsrce_visits has no column ${attr.column} on this warehouse` };
    }
    const sql = shapeSql({ attributes: [attr], queryKeys: [attr.id], filter: null, period: WINDOW }, planGroups([])[0]);
    const rows = await gateway.query(sql, { ...params, cellLimit: MAX_CELLS + 1 }, `shape:quality:${plan.id}:${attr.id}`);
    if (rows.length > MAX_CELLS) return { rows: [], skipped: `${subject.by} has more than ${MAX_CELLS} values in the window` };
    return {
      rows: rows.filter((row) => row.segment === 'all').map((row) => ({
        key: String(row[`a_${attr.id}`]),
        sessions: Number(row.sessions) || 0,
        buyers: Number(row.buyers) || 0,
        orders: Number(row.orders) || 0,
        revenue: Number(row.revenue) || 0,
        progressed: Number(row.progressed) || 0,
      })),
      skipped: null,
    };
  })();
  cache.set(key, pending);
  try {
    return await pending;
  } catch (err) {
    cache.delete(key);
    throw err;
  }
}

/**
 * Screens the site's kept sessions over a plan's query window with every
 * screen the dataset runs, and settles each finding: decided by a person,
 * awaiting a decision (the pending disposition applies), or auto.
 *
 * @param {import('../shaping/plan.js').ShapePlan} plan
 * @param {object} deps
 * @param {ReturnType<typeof import('./registry.js').createQualityRegistry>} deps.registry
 * @param {import('../../ports/query-gateway.js').QueryGateway} deps.gateway
 * @param {ReadonlyMap<string, import('../../domain/shaping/attributes.js').Attribute>} deps.attributes the site's attributes
 * @param {() => Promise<Set<string>>} deps.visitColumns
 * @param {Map<string, Promise<any>>} deps.cache
 * @param {{off: boolean, rules: Record<string, object>, add: any[]}} deps.request the request's quality block
 * @returns {Promise<{status: 'screened', result: QualityResult} | {status: 'invalid', reasons: string[]}>}
 */
export async function screenPlan(plan, deps) {
  const resolved = deps.registry.resolve(plan.idsite, plan.id, deps.request);
  if (resolved.problems.length > 0) return { status: 'invalid', reasons: resolved.problems };
  const decisions = deps.registry.decisions(plan.idsite);
  /** @type {QualityResult} */
  const result = { screens: [], off: resolved.off, findings: [], exclusions: { orders: [], visits: [], conditions: [], attributes: [] }, window: plan.queryWindow };

  for (const screen of resolved.screens) {
    const method = deps.registry.methods.get(screen.method.adapter);
    const triage = deps.registry.triages.get(screen.triage.adapter);
    const decided = decisionsFor(decisions, screen.id, plan.id);
    /** @type {ScreenRun} */
    const run = {
      id: screen.id,
      label: screen.label,
      purpose: screen.purpose,
      origin: screen.origin,
      subject: screen.subject,
      method: { adapter: method.id, params: screen.methodParams },
      triage: { adapter: triage.id, params: screen.triageParams },
      dispositions: { propose: screen.propose, pending: screen.pending, auto: screen.auto, scope: screen.scope },
      layers: screen.layers,
      stats: {},
      totals: null,
      skipped: null,
      reprocessed: decided.reprocess.map((d) => ({ finding: d.finding, at: d.at, by: d.by, note: d.note, params: d.params })),
      findings: [],
    };
    result.screens.push(run);
    const subject = await readSubject(screen.subject, plan, deps);
    if (subject.skipped) {
      run.skipped = subject.skipped;
      continue;
    }
    const totals = totalsOf(screen.subject.kind, subject.rows);
    run.totals = totals;
    const found = method.screen({ subject: screen.subject, rows: subject.rows, params: screen.methodParams, totals });
    run.stats = found.stats;
    if (found.skipped) run.skipped = found.skipped;

    for (const candidate of found.candidates) {
      const members = candidate.members.map((key) => memberKey(screen.subject, key));
      const { parts, open } = splitByDecisions(members, decided);
      const settle = (list, status, disposition, extra) => {
        const keys = new Set(list.map(rowKeyOf));
        const impact = impactOf(screen.subject.kind, subject.rows, totals, keys);
        const values = { ...candidate.values, count: list.length, ...impact };
        const units = { ...IMPACT_UNITS, ...(candidate.units ?? {}) };
        const verdict = status === 'decided' ? null : triage.triage({ candidate: { ...candidate, members: list.map(rowKeyOf) }, impact, params: screen.triageParams });
        const finalStatus = verdict ? (verdict.ask ? 'awaiting_decision' : 'auto') : status;
        const finalDisposition = verdict ? (verdict.ask ? screen.pending : screen.auto) : disposition;
        /** @type {Finding} */
        const finding = {
          id: findingId(plan.idsite, screen.id, list),
          screen: screen.id,
          label: list.length === members.length ? candidate.label : `${candidate.label} (${list.length} of ${members.length})`,
          subject: screen.subject,
          members: list,
          reason: candidate.reason,
          values,
          units,
          impact,
          status: /** @type {FindingStatus} */ (finalStatus),
          disposition: finalDisposition,
          proposed: screen.propose,
          scope: screen.scope,
          triage: verdict ? { adapter: triage.id, ...verdict } : null,
          decision: extra ?? null,
          question: renderQuestion(screen.question, values, units),
        };
        result.findings.push(finding);
        run.findings.push(finding.id);
        if (finding.disposition === 'exclude') addExclusion(result.exclusions, screen, list, subject.rows, deps.attributes);
      };
      for (const part of parts) {
        const d = part.decision;
        settle(part.members, 'decided', d.decision, { decision: d.decision, applies: d.applies, by: d.by, at: d.at, note: d.note, finding: d.finding, dataset: d.dataset });
      }
      if (open.length > 0) settle(open, 'open', null, null);
    }
  }
  result.exclusions.orders = [...new Set(result.exclusions.orders)].sort();
  result.exclusions.visits = [...new Set(result.exclusions.visits)].sort();
  return { status: 'screened', result };
}

function addExclusion(exclusions, screen, members, rows, attributes) {
  const keys = members.map(rowKeyOf);
  if (screen.subject.kind === 'orders') {
    if (screen.scope === 'order') exclusions.orders.push(...keys);
    else {
      const wanted = new Set(keys);
      exclusions.visits.push(...rows.filter((row) => wanted.has(String(row.key))).map((row) => String(row.idvisit)));
    }
    return;
  }
  const attr = attributes.get(screen.subject.by);
  const values = keys.map((key) => (attr.type === 'number' ? Number(key) : key));
  exclusions.conditions.push({ field: attr.id, in: values });
  if (!exclusions.attributes.some((known) => known.id === attr.id)) exclusions.attributes.push(attr);
}

/**
 * The plan a build runs with the exclusions applied: the attributes the
 * exclusion conditions read join the query's, and the SQL and parameters
 * carry the exclusions.
 * @param {import('../shaping/plan.js').ShapePlan} plan
 * @param {QualityResult['exclusions']} exclusions
 */
export function exclusionsForBuild(plan, exclusions) {
  const has = exclusions.orders.length > 0 || exclusions.visits.length > 0 || exclusions.conditions.length > 0;
  if (!has) return { plan, sql: NO_EXCLUSIONS, params: {} };
  const known = new Set(plan.attributes.map((attr) => attr.id));
  return {
    plan: { ...plan, attributes: [...plan.attributes, ...exclusions.attributes.filter((attr) => !known.has(attr.id))] },
    sql: { orders: exclusions.orders.length > 0, visits: exclusions.visits.length > 0, conditions: exclusions.conditions },
    params: {
      ...(exclusions.orders.length > 0 ? { qualityOrders: exclusions.orders } : {}),
      ...(exclusions.visits.length > 0 ? { qualityVisits: exclusions.visits } : {}),
    },
  };
}
