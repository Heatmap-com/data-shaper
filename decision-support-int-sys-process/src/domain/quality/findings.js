import { ratio } from './stats.js';

/**
 * Findings: what a screen's method found, split by what a person already
 * decided, with the impact of excluding each part and the question for the
 * part nobody has answered.
 *
 * @typedef {'auto' | 'awaiting_decision' | 'decided' | 'reprocessed'} FindingStatus
 */

/**
 * A row's key as a decision names it: `order:<idorder>`, or
 * `group:<attribute>=<value>`, so a decision cannot match the wrong kind.
 * @param {import('./screens.js').Subject} subject
 * @param {string} key
 */
export function memberKey(subject, key) {
  return subject.kind === 'orders' ? `order:${key}` : `group:${subject.by}=${key}`;
}

/** The row key inside a member key. @param {string} member */
export function rowKeyOf(member) {
  return member.startsWith('order:') ? member.slice('order:'.length) : member.slice(member.indexOf('=') + 1);
}

/**
 * Sums of a subject's rows.
 * @param {'orders' | 'groups'} kind
 * @param {ReadonlyArray<Record<string, any>>} rows
 * @returns {import('../../ports/quality.js').SubjectTotals}
 */
export function totalsOf(kind, rows) {
  if (kind === 'orders') return { rows: rows.length, orders: rows.length, revenue: sum(rows, 'revenue') };
  return { rows: rows.length, sessions: sum(rows, 'sessions'), buyers: sum(rows, 'buyers'), orders: sum(rows, 'orders'), revenue: sum(rows, 'revenue'), progressed: sum(rows, 'progressed') };
}

/**
 * What excluding the rows with these keys does to the subject's totals.
 * @param {'orders' | 'groups'} kind
 * @param {ReadonlyArray<Record<string, any>>} rows
 * @param {import('../../ports/quality.js').SubjectTotals} totals
 * @param {ReadonlySet<string>} keys row keys
 * @returns {import('../../ports/quality.js').Impact}
 */
export function impactOf(kind, rows, totals, keys) {
  const part = totalsOf(kind, rows.filter((row) => keys.has(String(row.key))));
  const share = (name) => ratio(part[name] ?? 0, totals[name] ?? 0) ?? 0;
  const impact = {
    orders: part.orders,
    orderShare: share('orders'),
    revenue: part.revenue,
    revenueShare: share('revenue'),
    aovWith: ratio(totals.revenue, totals.orders),
    aovWithout: ratio(totals.revenue - part.revenue, totals.orders - part.orders),
  };
  if (kind === 'orders') return impact;
  return {
    ...impact,
    sessions: part.sessions,
    sessionShare: share('sessions'),
    buyers: part.buyers,
    buyerShare: share('buyers'),
    conversionWith: ratio(totals.buyers, totals.sessions),
    conversionWithout: ratio(totals.buyers - part.buyers, totals.sessions - part.sessions),
  };
}

/** The units the impact values print in. */
export const IMPACT_UNITS = Object.freeze({
  orders: 'count', orderShare: 'share', revenue: 'money', revenueShare: 'share', aovWith: 'money', aovWithout: 'money',
  sessions: 'count', sessionShare: 'share', buyers: 'count', buyerShare: 'share', conversionWith: 'share', conversionWithout: 'share',
});

/**
 * One value as a reader sees it.
 * @param {unknown} value
 * @param {'money' | 'share' | 'count' | 'number' | undefined} unit
 */
export function formatValue(value, unit) {
  if (value === null || value === undefined) return 'n/a';
  if (typeof value !== 'number') return String(value);
  if (!Number.isFinite(value)) return 'n/a';
  switch (unit) {
    case 'share':
      return `${(value * 100).toFixed(value !== 0 && Math.abs(value) < 0.001 ? 3 : 2)}%`;
    case 'money':
      return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'count':
      return Math.round(value).toLocaleString('en-US');
    default:
      return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }
}

/**
 * The question with every {{name}} replaced. A name with no value is left
 * as it is, so a template typo shows in the output instead of vanishing.
 * @param {string} template
 * @param {Record<string, unknown>} values
 * @param {Record<string, string>} units
 */
export function renderQuestion(template, values, units) {
  return template.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (whole, name) => (
    Object.hasOwn(values, name) ? formatValue(values[name], /** @type {any} */ (units[name])) : whole));
}

/**
 * Splits a candidate's members by what was decided: each member decision
 * value takes its members; the standing rule decision takes the rest; what
 * remains is open.
 * @param {readonly string[]} members
 * @param {ReturnType<typeof import('./decisions.js').decisionsFor>} decided
 * @returns {{parts: Array<{decision: import('./decisions.js').Decision, members: string[]}>, open: string[]}}
 */
export function splitByDecisions(members, decided) {
  const byDecision = new Map();
  const open = [];
  for (const member of members) {
    const decision = decided.members.get(member) ?? decided.standing;
    if (!decision) {
      open.push(member);
      continue;
    }
    if (!byDecision.has(decision)) byDecision.set(decision, []);
    byDecision.get(decision).push(member);
  }
  return { parts: [...byDecision.entries()].map(([decision, list]) => ({ decision, members: list })), open };
}

function sum(rows, name) {
  let total = 0;
  for (const row of rows) total += Number(row[name]) || 0;
  return total;
}
