/**
 * Template interpretation: the weekly template series and the element
 * scorecard rows for each template.
 */

import { REQUIRED_CLASSES } from './element-classes.js';
import { SCORECARD_QUERY } from './queries/template.js';
import { isDirectional, round4 } from './stats.js';

const PAGE_TEMPLATES = ['home', 'plp', 'pdp', 'cart_page', 'checkout'];

/** Weekly page KPI twins of H1. Checkout completion is K1, not this row. */
const WEEKLY_TWIN = { plp: 'L1', pdp: 'P1', cart_page: 'C1' };

/**
 * @param {object[]} rawRows
 * @param {string} template filter; empty keeps every template
 */
export function interpretTemplateWeekly(rawRows, template = '') {
  /** @type {Array<{dims: object, metrics: object}>} */
  const out = [];
  for (const r of rawRows) {
    const name = String(r.template);
    if (template && name !== template) continue;
    if (!PAGE_TEMPLATES.includes(name) && name !== 'search') continue;
    const sessions = num(r.sessions);
    const buyers = num(r.buyers);
    const revenue = num(r.revenue);
    const row = {
      dims: {
        query: 'H1',
        week: day(r.week),
        template: name,
        device: String(r.device),
        returning: String(r.returning),
      },
      metrics: {
        sessions,
        buyers,
        revenue,
        cr: sessions > 0 ? round4((buyers / sessions) * 100) : null,
        page_rps: sessions > 0 ? round4(revenue / sessions) : null,
        directional: isDirectional(sessions, buyers),
      },
    };
    out.push(row);
    const twin = WEEKLY_TWIN[name];
    if (twin) out.push({ dims: { ...row.dims, query: twin }, metrics: { ...row.metrics } });
  }
  return out;
}

/**
 * One row per required class. Absent classes are reported with clicks 0.
 * @param {string} template
 * @param {object[]} rawRows
 * @param {object[]} entries entries for this idsite and template
 */
export function interpretScorecard(template, rawRows, entries) {
  const required = REQUIRED_CLASSES[template] ?? [];
  const query = SCORECARD_QUERY[template] ?? 'H4';
  /** @type {Array<{dims: object, metrics: object}>} */
  const out = [];
  for (const elementClass of required) {
    const mapped = entries.filter((e) => e.element_class === elementClass);
    const absent = mapped.length === 0 || mapped.every((e) => e.absent);
    const hits = rawRows.filter((r) => String(r.element_class) === elementClass);
    if (hits.length === 0) {
      out.push({
        dims: { query, template, element_class: elementClass, device: 'all', returning: 'all' },
        metrics: {
          absent,
          clicks: 0,
          clicking_sessions: 0,
          rage_clicks: 0,
          revenue: 0,
          click_rate: null,
          lift: null,
          directional: true,
          attribution: 'correlational',
        },
      });
      continue;
    }
    for (const hit of hits) {
      const clicks = num(hit.clicks);
      const revenue = num(hit.revenue);
      const sessions = num(hit.clicking_sessions);
      const viewing = num(hit.viewing_sessions);
      const viewingRevenue = num(hit.viewing_revenue);
      const nonClickers = Math.max(0, viewing - sessions);
      const nonClickerRevenue = viewingRevenue - revenue;
      const clickerRps = sessions > 0 ? revenue / sessions : null;
      const nonClickerRps = nonClickers > 0 ? nonClickerRevenue / nonClickers : null;
      out.push({
        dims: {
          query,
          template,
          element_class: elementClass,
          device: String(hit.device),
          returning: String(hit.returning),
        },
        metrics: {
          absent: false,
          element_name: String(hit.element_name ?? elementClass),
          clicks,
          clicking_sessions: sessions,
          viewing_sessions: viewing,
          rage_clicks: num(hit.rage_clicks),
          rage_click_rate: clicks > 0 ? round4(num(hit.rage_clicks) / clicks) : null,
          click_rate: viewing > 0 ? round4(sessions / viewing) : null,
          revenue,
          rpc: clicks > 0 ? round4(revenue / clicks) : null,
          clicker_rps: clickerRps == null ? null : round4(clickerRps),
          non_clicker_rps: nonClickerRps == null ? null : round4(nonClickerRps),
          lift: clickerRps != null && nonClickerRps != null && nonClickerRps !== 0 ? round4(clickerRps / nonClickerRps) : null,
          directional: sessions < 1000,
          attribution: 'correlational',
        },
      });
    }
  }
  return out;
}

/** @param {unknown} value */
function num(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** @param {unknown} value */
function day(value) {
  if (value == null || value === '') return null;
  return String(value).slice(0, 10);
}
