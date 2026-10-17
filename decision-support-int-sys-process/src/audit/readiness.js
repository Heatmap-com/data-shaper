/**
 * Readiness interpretation: the R rows, the freshness and revenue-trust
 * checks, and the verdict that gates the later stages.
 */

import { createTemplateClassifier } from './classify.js';
import { FRESHNESS } from './queries/readiness.js';
import { addDays } from './windows.js';

const REQUIRED_TEMPLATES = ['home', 'plp', 'pdp', 'cart_page'];

/**
 * @param {object} brand
 * @param {object} windows
 * @param {Record<string, {rows?: object[], error?: string}>} results
 * @param {{entries?: object[], urlRules?: object[]}} [inputs]
 */
export function interpretReadiness(brand, windows, results, inputs = {}) {
  const rows = [];
  const r1 = rowsOf(results, 'R1');
  const resolved = resolveSite(brand, r1.rows);
  rows.push(datasetRow('R1', { brand: brand.key }, {
    found: resolved.found,
    idsite: resolved.idsite,
    name: resolved.name,
    main_url: resolved.mainUrl,
    platform: resolved.platform,
    currency: resolved.currency,
    status: resolved.status,
    candidates: r1.rows.length,
    error: r1.error,
  }));

  const freshCutoff = addDays(windows.yesterday, -1);
  /** @type {Array<{id: string, required: boolean, maxDate: string | null, current: boolean, error: string | null}>} */
  const freshness = [];
  for (const source of FRESHNESS) {
    const got = rowsOf(results, `R2:${source.id}`);
    const maxDate = got.error ? null : dayOf(got.rows[0]?.max_date);
    const current = !got.error && maxDate != null && maxDate >= freshCutoff;
    freshness.push({ id: source.id, required: source.required, maxDate, current, error: got.error });
    rows.push(datasetRow('R2', { brand: brand.key, table: source.id }, {
      max_date: maxDate,
      current,
      required: source.required,
      error: got.error,
    }));
  }

  const r3 = rowsOf(results, 'R3');
  const gapDays = r3.error ? [] : gapDates(r3.rows, windows.trendStart, windows.trendEnd);
  rows.push(datasetRow('R3', { brand: brand.key }, {
    days_with_sessions: r3.rows.filter((r) => num(r.sessions) > 0).length,
    gap_days: gapDays.length,
    gap_sample: gapDays.slice(0, 12),
    error: r3.error,
  }));

  const r4 = rowsOf(results, 'R4');
  const unmatched = rowsOf(results, 'R4unmatched');
  const orders = num(r4.rows[0]?.orders);
  const zeroRevenue = num(r4.rows[0]?.zero_revenue);
  const distinctOrders = num(r4.rows[0]?.distinct_orders);
  const duplicates = Math.max(0, orders - distinctOrders);
  const unmatchedOrders = num(unmatched.rows[0]?.unmatched);
  const zeroShare = orders > 0 ? zeroRevenue / orders : 1;
  const unmatchedShare = orders > 0 ? unmatchedOrders / orders : 1;
  const duplicateShare = orders > 0 ? duplicates / orders : 0;
  const r4error = r4.error || unmatched.error || null;
  let revenueTrust = 'clean';
  if (r4error || orders === 0 || zeroShare > 0.5 || duplicateShare > 0.05) revenueTrust = 'untrusted';
  else if (zeroShare >= 0.05 || duplicates > 0 || unmatchedShare >= 0.05) revenueTrust = 'dirty';
  rows.push(datasetRow('R4', { brand: brand.key }, {
    orders,
    zero_revenue_share: round4(zeroShare),
    duplicate_orders: duplicates,
    unmatched_share: round4(unmatchedShare),
    trust: revenueTrust,
    error: r4error,
  }));

  const pages = rowsOf(results, 'R5pages');
  const urls = rowsOf(results, 'R5urls');
  const rules = (inputs.urlRules ?? []).filter((r) => r.idsite === resolved.idsite);
  const byTemplate = templateShares(pages.rows, urls.rows, rules);
  const covered = REQUIRED_TEMPLATES.filter((t) => (byTemplate[t] ?? 0) > 0);
  rows.push(datasetRow('R5', { brand: brand.key }, {
    by_template: byTemplate,
    covered,
    unclassified_share: round4(byTemplate.unclassified ?? 0),
    error: pages.error || urls.error || null,
  }));

  const r6 = rowsOf(results, 'R6');
  const byEvent = Object.fromEntries(r6.rows.map((r) => [String(r.event_type), num(r.sessions)]));
  const completed = byEvent.checkout_completed ?? 0;
  const reconcile = orders > 0 ? Math.abs(completed - orders) / orders : null;
  rows.push(datasetRow('R6', { brand: brand.key }, {
    by_event: byEvent,
    checkout_completed: completed,
    orders,
    reconcile_gap: reconcile == null ? null : round4(reconcile),
    cart_viewed: byEvent.cart_viewed ?? 0,
    error: r6.error,
  }));

  const r7 = rowsOf(results, 'R7');
  rows.push(datasetRow('R7', { brand: brand.key }, {
    first_date: r7.error ? null : dayOf(r7.rows[0]?.first_date),
    pages: num(r7.rows[0]?.pages),
    elements: num(r7.rows[0]?.elements),
    error: r7.error,
  }));

  const r8 = rowsOf(results, 'R8');
  const quadrants = r8.rows.map((r) => ({
    device: String(r.device),
    returning: String(r.returning),
    channel: String(r.channel),
    sessions: num(r.sessions),
    buyers: num(r.buyers),
    directional: num(r.sessions) < 1000 || num(r.buyers) < 30,
  }));
  const reportable = quadrants.filter((q) => !q.directional).length;
  rows.push(datasetRow('R8', { brand: brand.key }, {
    quadrants: quadrants.length,
    reportable,
    reportable_share: quadrants.length > 0 ? round4(reportable / quadrants.length) : 0,
    error: r8.error,
  }));

  const r10 = rowsOf(results, 'R10');
  rows.push(datasetRow('R10', { brand: brand.key }, {
    weeks: r10.rows.length,
    error: r10.error,
  }));
  for (const week of r10.rows) {
    const raw = num(week.sessions_raw);
    const kept = num(week.sessions_kept);
    rows.push(datasetRow('R10', { brand: brand.key, week: dayOf(week.week) }, {
      sessions_raw: raw,
      sessions_kept: kept,
      removed_share: raw > 0 ? round4((raw - kept) / raw) : null,
    }));
  }

  const r11 = rowsOf(results, 'R11');
  rows.push(datasetRow('R11', { brand: brand.key }, { weeks: r11.rows.length, error: r11.error }));
  const r12 = rowsOf(results, 'R12');
  rows.push(datasetRow('R12', { brand: brand.key }, {
    event_ids: r12.rows.length,
    error: r12.error,
  }));
  const r13 = rowsOf(results, 'R13');
  rows.push(datasetRow('R13', { brand: brand.key }, {
    rows: num(r13.rows[0]?.rows),
    error: r13.error,
  }));

  const matrixEntries = (inputs.entries ?? []).filter((e) => e.idsite === resolved.idsite);
  const r9 = rowsOf(results, 'R9');
  const clicks = num(r9.rows[0]?.clicks);
  const matched = num(r9.rows[0]?.matched);
  const matchShare = clicks > 0 ? matched / clicks : null;
  rows.push(datasetRow('R9', { brand: brand.key }, {
    matrix_entries: matrixEntries.length,
    clicks,
    matched,
    match_share: matchShare == null ? null : round4(matchShare),
    error: r9.error,
  }));

  const requiredFresh = freshness.filter((f) => f.required);
  const r2stale = requiredFresh.some((f) => !f.current);
  const r5ok = REQUIRED_TEMPLATES.every((t) => covered.includes(t));
  const r6ok = reconcile != null && reconcile <= 0.1 && !r6.error;
  const r9ok = matrixEntries.length > 0 && matchShare != null && matchShare >= 0.8 && !r9.error;
  const r3ok = !r3.error && gapDays.length === 0 && r3.rows.some((r) => num(r.sessions) > 0);

  let verdict = 'ready';
  /** @type {string[]} */
  const reasons = [];
  if (!resolved.found || r1.error) {
    verdict = 'blocked';
    reasons.push('R1 missing');
  } else if (r2stale) {
    verdict = 'blocked';
    reasons.push('R2 stale');
  } else if (revenueTrust === 'untrusted') {
    verdict = 'blocked';
    reasons.push('R4 revenue untrusted');
  } else if (!r3ok || !r5ok || !r6ok || !r9ok || revenueTrust !== 'clean') {
    verdict = 'partial';
    if (!r3ok) reasons.push('R3 gaps or empty');
    if (revenueTrust !== 'clean') reasons.push('R4 dirty');
    if (!r5ok) reasons.push(`R5 missing ${REQUIRED_TEMPLATES.filter((t) => !covered.includes(t)).join(', ')}`);
    if (!r6ok) reasons.push('R6 checkout does not reconcile within 10%');
    if (!r9ok) reasons.push('R9 matrix covers under 80% of clicks');
  }

  rows.push(datasetRow('readiness', { brand: brand.key }, {
    verdict,
    reasons,
    idsite: resolved.idsite,
    bot_exclusion: 'portal §11.4',
    window_start: windows.trendStart,
    window_end: windows.trendEnd,
    snapshot_start: windows.snapshotStart,
    snapshot_end: windows.snapshotEnd,
  }));

  return {
    verdict,
    reasons,
    idsite: resolved.idsite,
    reportableShare: quadrants.length > 0 ? reportable / quadrants.length : 0,
    completeness: queryCompleteness(results),
    rows,
  };
}

/** @param {{idsite: number, name: string, domain: string}} brand @param {object[]} sites */
export function resolveSite(brand, sites) {
  const list = sites ?? [];
  const exact = brand.idsite > 0 ? list.filter((s) => Number(s.idsite) === brand.idsite) : [];
  const chosen = exact[0] ?? (list.length === 1 ? list[0] : null);
  if (!chosen) {
    return { found: false, idsite: brand.idsite || 0, name: '', mainUrl: '', platform: '', currency: '', status: '' };
  }
  return {
    found: true,
    idsite: Number(chosen.idsite),
    name: String(chosen.name ?? ''),
    mainUrl: String(chosen.main_url ?? ''),
    platform: String(chosen.platform ?? ''),
    currency: String(chosen.currency ?? ''),
    status: String(chosen.status ?? ''),
  };
}

/** @param {object[]} pageRows @param {object[]} urlRows @param {object[]} rules */
function templateShares(pageRows, urlRows, rules) {
  const urls = new Map(urlRows.map((r) => [String(r.idsitehsr), String(r.url ?? '')]));
  /** @type {Record<string, number>} */
  const counts = {};
  let total = 0;
  const classify = createTemplateClassifier(rules);
  for (const row of pageRows) {
    const n = num(row.pageviews);
    total += n;
    const template = classify(urls.get(String(row.idsitehsr)) ?? '');
    counts[template] = (counts[template] ?? 0) + n;
  }
  /** @type {Record<string, number>} */
  const shares = {};
  for (const [template, n] of Object.entries(counts)) {
    shares[template] = total > 0 ? n / total : 0;
  }
  shares._pageviews = total;
  return shares;
}

/** Days in the trend window with no sessions. A ready brand has none. */
export function gapDates(daily, start, end) {
  const byDay = new Map(daily.map((r) => [dayOf(r.day), num(r.sessions)]));
  /** @type {string[]} */
  const gaps = [];
  let cursor = start;
  while (cursor <= end) {
    if ((byDay.get(cursor) ?? 0) <= 0) gaps.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return gaps;
}

/** @param {Record<string, {rows?: object[], error?: string}>} results */
function queryCompleteness(results) {
  const ids = Object.keys(results);
  if (ids.length === 0) return 0;
  const ok = ids.filter((id) => !results[id]?.error).length;
  return ok / ids.length;
}

/** @param {Record<string, {rows?: object[], error?: string}>} results @param {string} id */
function rowsOf(results, id) {
  const got = results[id];
  if (!got) return { rows: [], error: null };
  if (got.error) return { rows: [], error: got.error };
  return { rows: got.rows ?? [], error: null };
}

/** @param {string} queryId @param {object} dims @param {object} metrics */
function datasetRow(queryId, dims, metrics) {
  return { dims: { query: queryId, ...dims }, metrics };
}

/** @param {unknown} value */
function num(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** @param {unknown} value */
function dayOf(value) {
  if (value == null || value === '') return null;
  return String(value).slice(0, 10);
}

/** @param {number} n */
function round4(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10000) / 10000;
}
