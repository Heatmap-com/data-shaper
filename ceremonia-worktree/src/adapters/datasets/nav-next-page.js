import { getClickRows } from '../_lib/clicks.js';
import { getPageviewSequences } from '../_lib/clicks.js';
import { namesForPage } from '../_lib/element-names.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';
import { fetchHsrUrls } from '../_lib/urls.js';
import { pageType } from '../../page-type.js';

/**
 * nav-next-page: where entry sessions that clicked any selector on the page
 * went next (v2 widens the population from nav classes to every clicked
 * selector). The next page is the following pageview's URL class, resolved
 * through site_hsr.screenshot_url: 'exit' when the click's pageview is the
 * session's last, 'offsite' when the next pageview's resolved host differs
 * from the page's host. Rows for unclassed selectors with fewer than 20
 * clicking sessions are dropped; classed selectors keep all rows. Rule 10.
 */

// Unclassed selectors need this many clicking sessions to keep their rows
// (the engine-side population cut; nav-classed rows are always kept).
const MIN_UNCLASSED_CLICKING_SESSIONS = 20;

export const adapter = {
  id: 'nav-next-page',
  dependsOn: ['selector-weekly'],
  scope: 'page',
  provides: ['H11'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const [clicks, sessions, sequences, urls] = await Promise.all([
      getClickRows(ctx, page),
      fetchSessionRows(ctx, page.idsite),
      getPageviewSequences(ctx, page),
      fetchHsrUrls(ctx, page.idsite),
    ]);
    const hsr = String(page.idsitehsr);

    /** @type {Map<string, object>} idvisit -> session, page entry sessions only */
    const pageSessions = new Map();
    for (const s of sessions) {
      if (s.entryHsr === hsr) pageSessions.set(s.idvisit, s);
    }

    const elementFor = await namesForPage(ctx, page);

    const pageHost = hostOf(urls.get(hsr) ?? '');

    /** @type {Map<string, Map<string, number>>} idvisit -> idloghsr -> index in the session's sequence */
    const indexByVisit = new Map();
    /** @param {string} idvisit @param {string} idloghsr */
    const indexOf = (idvisit, idloghsr) => {
      let byLog = indexByVisit.get(idvisit);
      if (!byLog) {
        byLog = new Map();
        const seq = sequences.get(idvisit) ?? [];
        seq.forEach((pv, i) => {
          if (!byLog.has(pv.idloghsr)) byLog.set(pv.idloghsr, i);
        });
        indexByVisit.set(idvisit, byLog);
      }
      return byLog.get(idloghsr);
    };

    /** @type {Map<string, object>} */
    const cells = new Map();
    let pageClicks = 0;
    for (const click of clicks) {
      const session = pageSessions.get(click.idvisit);
      if (!session) continue;
      pageClicks += 1;
      const element = await elementFor(click.selector);
      const elementClass = element?.element.element_class ?? '';
      const seq = sequences.get(click.idvisit);
      if (!seq || seq.length === 0) continue;
      const idx = indexOf(click.idvisit, click.idloghsr);
      if (idx == null) continue;
      let nextType;
      if (idx >= seq.length - 1) {
        nextType = 'exit';
      } else {
        const nextUrl = urls.get(seq[idx + 1].hsr) ?? '';
        const nextHost = hostOf(nextUrl);
        nextType =
          pageHost !== '' && nextHost !== '' && nextHost !== pageHost ? 'offsite' : pageType(nextUrl);
      }
      for (const filter of filtersFor(session.tier)) {
        const dims = { selector: click.selector, element_class: elementClass, next_page_type: nextType, bot_filter: filter };
        const key = JSON.stringify(dims);
        let cell = cells.get(key);
        if (!cell) {
          cell = { dims, clickVisits: new Set(), orderVisits: new Set(), revenue: 0 };
          cells.set(key, cell);
        }
        if (!cell.clickVisits.has(click.idvisit)) {
          cell.clickVisits.add(click.idvisit);
          cell.revenue += session.revenue;
        }
        if (session.orders > 0) cell.orderVisits.add(click.idvisit);
      }
    }

    if (pageClicks === 0) {
      return {
        id: adapter.id,
        rows: [],
        notes: { nav_next_page_note: 'no clicked selectors on page sessions; blocked' },
      };
    }

    // Engine-side population cut: an unclassed selector keeps its rows only
    // at MIN_UNCLASSED_CLICKING_SESSIONS+ clicking sessions; a classed
    // selector keeps every row. Population is the selector's distinct
    // clickers on the unfiltered ('none') bot tier.
    /** @type {Map<string, Set<string>>} selector -> clicker idvisits */
    const clickersBySelector = new Map();
    for (const cell of cells.values()) {
      if (cell.dims.bot_filter !== 'none') continue;
      let set = clickersBySelector.get(cell.dims.selector);
      if (!set) {
        set = new Set();
        clickersBySelector.set(cell.dims.selector, set);
      }
      for (const idvisit of cell.clickVisits) set.add(idvisit);
    }

    const rows = [];
    for (const cell of cells.values()) {
      if (cell.dims.element_class === '') {
        const population = clickersBySelector.get(cell.dims.selector)?.size ?? 0;
        if (population < MIN_UNCLASSED_CLICKING_SESSIONS) continue;
      }
      rows.push({
        dims: cell.dims,
        metrics: {
          clicking_sessions: cell.clickVisits.size,
          sessions_with_order: cell.orderVisits.size,
          revenue_udp: round2(cell.revenue),
        },
      });
    }

    return { id: adapter.id, rows };
  },
};

/** @param {string} url */
function hostOf(url) {
  if (!url || !url.includes('://')) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}
