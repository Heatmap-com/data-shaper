import { groupSpread, normalQuantile } from '../../enrichment/tag-stats.js';

/**
 * Selects tag keys that describe where a visit came from, then keeps the
 * ones whose values earn differently. A key is read by name first. Keys
 * that name a person, a single click, or a product are dropped before any
 * value scan. A traffic key is trended when its values differ in revenue
 * per session or in average order value beyond what the sample explains,
 * and by enough to act on.
 */

const MIN_TAGGED_SESSIONS = 200;
/** Distinct values per tagged visit above this is an identifier, one value per visitor or click. */
const MAX_DISTINCT_SHARE = 0.5;
const MIN_VALUE_SESSIONS = 100;
const MIN_VALUE_ORDERS = 10;
/** Share of the key's tagged sessions that sits in values large enough to read. */
const MIN_COVERAGE = 0.25;
/** One-sided, split across every test the run makes: two per candidate key. */
const ALPHA = 0.05;
const MIN_RPS_SPREAD = 0.2;
const MIN_AOV_SPREAD = 0.15;
const MAX_TREND_VALUES = 8;
const SUMMARY_VALUES = 20;

/** First match wins. `traffic: false` families are dropped by name. */
const KEY_RULES = [
  { family: 'click_id', traffic: false, re: /^(gclid|gbraid|wbraid|dclid|fbclid|msclkid|ttclid|twclid|li_fat_id|irclickid|sccid|epik)$/ },
  { family: 'identity', traffic: false, re: /(profile|visitor|user|customer|client|subscriber|email|session)(_?id)?$/ },
  { family: 'source', traffic: true, re: /(^|_)(source|src|ref|referrer|referer)$/ },
  { family: 'medium', traffic: true, re: /(^|_)medium$/ },
  { family: 'campaign', traffic: true, re: /campaign|^utm_id$/ },
  { family: 'ad', traffic: true, re: /^(ad|ads|adset|ad_set|adgroup|ad_group|creative|placement)(_?(id|name))?$/ },
  { family: 'content', traffic: true, re: /(^|_)content$/ },
  { family: 'term', traffic: true, re: /(^|_)(term|keyword|kw)$/ },
  { family: 'channel', traffic: true, re: /(^|_)channel$/ },
  { family: 'affiliate', traffic: true, re: /(^|_)(affiliate|partner|aff)(_?id)?$/ },
];

/** @type {import('../../ports/session-tag-selector.js').SessionTagSelector} */
export const adapter = {
  id: 'traffic-variance',

  candidates(inventory) {
    return inventory.map((row) => {
      const key = String(row.key).toLowerCase();
      const visits = Number(row.visits) || 0;
      const distinctValues = Number(row.distinctValues) || 0;
      const rule = KEY_RULES.find((item) => item.re.test(key));
      const base = verdict(key, rule?.family ?? 'other', visits, distinctValues);
      if (!rule) return { ...base, status: 'rejected', reason: 'not a traffic key' };
      if (!rule.traffic) return { ...base, status: 'rejected', reason: `${rule.family} key` };
      if (visits < MIN_TAGGED_SESSIONS) {
        return { ...base, status: 'rejected', reason: `${visits} tagged visits, under ${MIN_TAGGED_SESSIONS}` };
      }
      if (distinctValues / visits > MAX_DISTINCT_SHARE) {
        return { ...base, status: 'rejected', reason: `${distinctValues} values on ${visits} visits reads as an identifier` };
      }
      return { ...base, status: 'candidate', reason: `${rule.family} key` };
    });
  },

  select({ candidates, values }) {
    const minZ = normalQuantile(1 - ALPHA / (2 * Math.max(1, candidates.length)));
    /** @type {Map<string, import('../../ports/session-tag-selector.js').TagValueStats[]>} */
    const byKey = new Map();
    for (const row of values) {
      const list = byKey.get(row.key) ?? [];
      list.push(row);
      byKey.set(row.key, list);
    }
    return candidates.map((candidate) => {
      const rows = (byKey.get(candidate.key) ?? []).slice().sort(bySessions);
      const taggedSessions = rows.reduce((sum, row) => sum + row.sessions, 0);
      const summaries = rows.slice(0, SUMMARY_VALUES).map(summary);
      const base = { ...candidate, taggedSessions, values: summaries };
      const readable = rows.filter((row) => row.sessions >= MIN_VALUE_SESSIONS);
      if (readable.length < 2) {
        return { ...base, status: 'rejected', reason: `${readable.length} value(s) with ${MIN_VALUE_SESSIONS}+ sessions` };
      }
      const coverage = readable.reduce((sum, row) => sum + row.sessions, 0) / taggedSessions;
      if (coverage < MIN_COVERAGE) {
        return { ...base, status: 'rejected', reason: `values with ${MIN_VALUE_SESSIONS}+ sessions hold ${pct(coverage)} of tagged sessions` };
      }
      const rps = groupSpread(readable.map((row) => ({ n: row.sessions, sum: row.revenue, sumSq: row.visitRevenueSq })));
      const aovRows = rows.filter((row) => row.orders >= MIN_VALUE_ORDERS);
      const aov = aovRows.length >= 2
        ? groupSpread(aovRows.map((row) => ({ n: row.orders, sum: row.revenue, sumSq: row.orderRevenueSq })))
        : null;
      const rpsMoves = rps.z >= minZ && rps.spread >= MIN_RPS_SPREAD;
      const aovMoves = aov != null && aov.z >= minZ && aov.spread >= MIN_AOV_SPREAD;
      const scored = { ...base, rps, aov };
      if (!rpsMoves && !aovMoves) {
        return { ...scored, status: 'rejected', reason: `values earn alike at z ${fixed(minZ)} (RPS z ${fixed(rps.z)}, spread ${fixed(rps.spread)}; AOV ${aov ? `z ${fixed(aov.z)}, spread ${fixed(aov.spread)}` : 'too few orders'})` };
      }
      const moved = [rpsMoves ? `RPS z ${fixed(rps.z)}, spread ${fixed(rps.spread)}` : '', aovMoves ? `AOV z ${fixed(aov.z)}, spread ${fixed(aov.spread)}` : '']
        .filter(Boolean)
        .join('; ');
      return {
        ...scored,
        status: 'selected',
        reason: moved,
        trendValues: readable.slice(0, MAX_TREND_VALUES).map((row) => row.value),
      };
    });
  },
};

/**
 * @param {string} key
 * @param {string} family
 * @param {number} visits
 * @param {number} distinctValues
 * @returns {import('../../ports/session-tag-selector.js').TagKeyVerdict}
 */
function verdict(key, family, visits, distinctValues) {
  return {
    key,
    family,
    status: 'rejected',
    reason: '',
    taggedSessions: visits,
    distinctValues,
    rps: null,
    aov: null,
    trendValues: [],
    values: [],
  };
}

/** @param {import('../../ports/session-tag-selector.js').TagValueStats} row */
function summary(row) {
  return {
    value: row.value,
    sessions: row.sessions,
    orders: row.orders,
    revenue: Math.round(row.revenue * 100) / 100,
    rps: row.sessions > 0 ? Math.round((row.revenue / row.sessions) * 100) / 100 : 0,
    aov: row.orders > 0 ? Math.round((row.revenue / row.orders) * 100) / 100 : null,
  };
}

function bySessions(a, b) {
  return b.sessions - a.sessions || (a.value < b.value ? -1 : 1);
}

/** @param {number} n */
function fixed(n) {
  return Number(n).toFixed(2);
}

/** @param {number} n */
function pct(n) {
  return `${Math.round(n * 100)}%`;
}
