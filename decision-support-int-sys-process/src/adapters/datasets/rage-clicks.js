import { timeSinceLoadUnit } from '../_lib/checks.js';
import { getClickRows } from '../_lib/clicks.js';
import { deviceName } from '../_lib/dims.js';
import { namesForPage } from '../_lib/element-names.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';

/**
 * rage-clicks: entry sessions that raged on a selector, under two
 * independent rules that are never summed (a session can count under both):
 * rule 'engine_3in2s' is 3+ clicks on one selector whose time_since_load
 * values span 2 seconds or less; rule 'portal_meta1' is any click whose
 * meta1 is 'rage'. Empty rows when the time_since_load unit is not
 * confirmed; no conversion is guessed. Rule 8.
 */

const MIN_RAGE_CLICKS = 3;

const RULE_ENGINE = 'engine_3in2s';
const RULE_PORTAL = 'portal_meta1';

export const adapter = {
  id: 'rage-clicks',
  dependsOn: ['selector-weekly'],
  scope: 'page',
  provides: ['H10'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const unit = await timeSinceLoadUnit(ctx, page);
    if (unit === 'unknown') {
      return {
        id: adapter.id,
        rows: [],
        notes: {
          rage_clicks_unit: 'unknown',
          rage_clicks_note: 'time_since_load unit not confirmed; no rage rows',
        },
      };
    }
    const span = unit === 'ms' ? 2000 : 2;

    const [clicks, sessions] = await Promise.all([getClickRows(ctx, page), fetchSessionRows(ctx, page.idsite)]);
    const hsr = String(page.idsitehsr);

    /** @type {Map<string, object>} idvisit -> session, page entry sessions only */
    const pageSessions = new Map();
    for (const s of sessions) {
      if (s.entryHsr === hsr) pageSessions.set(s.idvisit, s);
    }

    const elementFor = await namesForPage(ctx, page);

    /**
     * A group's timed clicks are kept as their count and span, all the
     * 3-in-2s rule reads.
     * @type {Map<string, {idvisit: string, selector: string, timed: number, first: number, last: number, portalRage: boolean, weeks: string[]}>}
     */
    const byVisitSelector = new Map();
    for (const click of clicks) {
      if (!pageSessions.has(click.idvisit)) continue;
      const key = `${click.idvisit}|${click.selector}`;
      let group = byVisitSelector.get(key);
      if (!group) {
        group = { idvisit: click.idvisit, selector: click.selector, timed: 0, first: Infinity, last: -Infinity, portalRage: false, weeks: [] };
        byVisitSelector.set(key, group);
      }
      // null time_since_load (-1) cannot establish a 2-second span
      if (click.timeSinceLoad >= 0) {
        group.timed += 1;
        if (click.timeSinceLoad < group.first) group.first = click.timeSinceLoad;
        if (click.timeSinceLoad > group.last) group.last = click.timeSinceLoad;
      }
      if (click.meta1 === 'rage') group.portalRage = true;
      if (!group.weeks.includes(click.week)) group.weeks.push(click.week);
    }

    /**
     * A visit adds to a cell once: the cell's dims hold the group's selector
     * and one of its weeks, so the visit counts stand in for sets of visits.
     * @type {Map<string, {dims: object, rageVisits: number, clickVisits: number}>}
     */
    const cells = new Map();
    for (const group of byVisitSelector.values()) {
      const { idvisit, selector, portalRage } = group;
      const engineRage = group.timed >= MIN_RAGE_CLICKS && group.last - group.first <= span;
      const session = pageSessions.get(idvisit);
      const device = deviceName(session.device);
      const browser = session.browser.trim().toLowerCase() === '' ? 'unknown' : session.browser.trim().toLowerCase();
      for (const week of group.weeks) {
        const element = await elementFor(selector);
        for (const filter of filtersFor(session.tier)) {
          for (const rule of [RULE_ENGINE, RULE_PORTAL]) {
            const dims = {
              week,
              selector,
              device,
              browser,
              rule,
              bot_filter: filter,
              element_id: element?.element.element_id ?? '',
              element_class: element?.element.element_class ?? '',
              am_label: '',
              am_role: '',
            };
            const ck = JSON.stringify(dims);
            let cell = cells.get(ck);
            if (!cell) {
              cell = { dims, rageVisits: 0, clickVisits: 0 };
              cells.set(ck, cell);
            }
            cell.clickVisits += 1;
            if ((rule === RULE_ENGINE && engineRage) || (rule === RULE_PORTAL && portalRage)) {
              cell.rageVisits += 1;
            }
          }
        }
      }
    }

    const rows = Array.from(cells.values(), (cell) => ({
      dims: cell.dims,
      metrics: {
        rage_sessions: cell.rageVisits,
        clicking_sessions: cell.clickVisits,
      },
    }));

    return {
      id: adapter.id,
      rows,
      notes: { rage_clicks_unit: unit, rage_clicks_span_seconds: span / (unit === 'ms' ? 1000 : 1) },
    };
  },
};
