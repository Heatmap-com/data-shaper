import { pageType } from '../../page-type.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';
import { mapState } from '../../scan/snapshot.js';

/**
 * Qualifier: prefer a non-home page when it carries orders and at least
 * minShareOfHome of the homepage's entry sessions; otherwise take the
 * homepage. The volume gate is minHits pageview hits on that one page in the
 * batch window (the last 7 complete UTC days). A preferred page that fails
 * is not replaced by the homepage. IMPLEMENTATION-PLAN.md section 3.
 *
 * Numbers are bot-filtered (exclude_confirmed); the bot_filter=none totals
 * ride along in the evidence for reconciliation and the analysis row.
 *
 * The session reduction is a folder (open, fold, finish) so the day scan's
 * site pass can feed it a day at a time; qualify folds the window's rows.
 */

function blank() {
  return { sessions: 0, orders: 0, revenue: 0 };
}

/**
 * Pageview hits on the chosen page during the batch window. Hits are rows
 * in udp_hsrce_pageviews for every idsitehsr that resolved to that URL.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @param {string[]} hsrs
 */
async function pageHits(ctx, idsite, hsrs) {
  const list = hsrs.map((h) => Number(h)).filter((n) => Number.isInteger(n) && n > 0);
  if (list.length === 0) return 0;
  const rows = await ctx.gateway.query(
    `SELECT count() AS hits
       FROM default.udp_hsrce_pageviews
      WHERE idsite = {idsite:UInt32}
        AND idsitehsr IN (${list.join(',')})
        AND server_date BETWEEN {w0:Date} AND {w1:Date}`,
    { idsite, w0: ctx.windowStart, w1: ctx.windowEnd, hsrs: list.join(',') },
    'pageviews:page-hits',
  );
  return Number(rows[0]?.hits ?? 0);
}

/** @param {{sessions: number, orders: number, revenue: number}} into @param {{sessions: number, orders: number, revenue: number}} from */
function addTotals(into, from) {
  into.sessions += from.sessions;
  into.orders += from.orders;
  into.revenue += from.revenue;
}

/**
 * Resolves idsitehsr -> url/title through site_hsr.screenshot_url/name.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 */
async function resolvePages(ctx, idsite) {
  const rows = await ctx.gateway.query(
    `SELECT toString(idsitehsr) AS hsr, any(screenshot_url) AS url, any(name) AS title
       FROM default.site_hsr
      WHERE idsite = {idsite:UInt32}
      GROUP BY idsitehsr`,
    { idsite },
    'site_hsr:resolve-pages',
  );
  /** @type {Map<string, {url: string, title: string}>} */
  const pages = new Map();
  for (const r of rows) {
    pages.set(String(r.hsr), { url: String(r.url ?? ''), title: String(r.title ?? '') });
  }
  return pages;
}

const byVolume = (a, b) =>
  b.exclude_confirmed.sessions - a.exclude_confirmed.sessions ||
  b.exclude_confirmed.orders - a.exclude_confirmed.orders ||
  (a.url < b.url ? -1 : 1);

export const adapter = {
  id: 'prefer-non-home',
  // minSessions / minOrders stay on the batch row. This qualifier's volume
  // gate is minHits (pageviews of the chosen page), not those two columns.
  config: { minShareOfHome: 0.5, minHits: 100, minSessions: 100, minOrders: 0 },

  /**
   * @param {{idsite: number, siteName: string}} site
   * @param {import('../../ports/dataset.js').RunContext} ctx
   * @returns {Promise<import('../../ports/qualifier.js').Qualification>}
   */
  async qualify(site, ctx) {
    const folder = adapter.open(site, ctx);
    folder.fold(await fetchSessionRows(ctx, site.idsite));
    return folder.finish(site, ctx);
  },

  /**
   * Entry totals per entry page and bot tier. Entry id 0 is not a page.
   * @param {{idsite: number}} _site
   * @param {import('../../ports/dataset.js').RunContext} _ctx
   */
  open(_site, _ctx) {
    /** @type {Map<string, {none: object, exclude_confirmed: object}>} */
    const byHsr = new Map();
    return {
      ...mapState(byHsr),
      /** @param {object[]} sessions */
      fold(sessions) {
        for (const s of sessions) {
          if (s.entryHsr === '' || s.entryHsr === '0') continue;
          let cell = byHsr.get(s.entryHsr);
          if (!cell) {
            cell = { none: blank(), exclude_confirmed: blank() };
            byHsr.set(s.entryHsr, cell);
          }
          for (const filter of filtersFor(s.tier)) {
            addTotals(cell[filter], { sessions: 1, orders: s.orders, revenue: s.revenue });
          }
        }
      },
      /**
       * @param {{idsite: number, siteName: string}} site
       * @param {import('../../ports/dataset.js').RunContext} ctx
       */
      async finish(site, ctx) {
        return choose(site, ctx, byHsr, await resolvePages(ctx, site.idsite));
      },
    };
  },
};

/**
 * @param {{idsite: number}} site
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {Map<string, {none: object, exclude_confirmed: object}>} byHsr
 * @param {Map<string, {url: string, title: string}>} hsrPages
 * @returns {Promise<import('../../ports/qualifier.js').Qualification>}
 */
async function choose(site, ctx, byHsr, hsrPages) {
  const { minShareOfHome, minHits } = adapter.config;

  // Entry pages that resolve to one URL add up; the URL's hsr is its
  // busiest entry page (all sessions, any tier).
  /** @type {Map<string, {none: object, exclude_confirmed: object, hsrs: Map<string, number>}>} */
  const byUrl = new Map();
  for (const [hsr, totals] of byHsr) {
    const page = hsrPages.get(hsr);
    if (!page || !page.url) continue;
    let cell = byUrl.get(page.url);
    if (!cell) {
      cell = { none: blank(), exclude_confirmed: blank(), hsrs: new Map() };
      byUrl.set(page.url, cell);
    }
    cell.hsrs.set(hsr, totals.none.sessions);
    addTotals(cell.none, totals.none);
    addTotals(cell.exclude_confirmed, totals.exclude_confirmed);
  }

  if (byUrl.size === 0) {
    return { status: 'skipped_no_page', reason: 'no entry page with a resolvable URL' };
  }

  /** @type {Array<{url: string, type: string, title: string, none: object, exclude_confirmed: object, hsr: string}>} */
  const candidates = [];
  for (const [url, cell] of byUrl) {
    const sortedHsrs = [...cell.hsrs.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const hsr = sortedHsrs[0][0];
    const resolved = hsrPages.get(hsr);
    candidates.push({
      url,
      type: pageType(url),
      title: resolved?.title ?? '',
      none: cell.none,
      exclude_confirmed: cell.exclude_confirmed,
      hsr,
    });
  }

  const home = candidates
    .filter((c) => c.type === 'home')
    .sort((a, b) => b.exclude_confirmed.sessions - a.exclude_confirmed.sessions || (a.url < b.url ? -1 : 1))[0];
  const nonHome = candidates.filter((c) => c.type !== 'home');

  // A non-home page is preferred when it has at least one order and its
  // entry sessions are at least half the homepage's (or greater). With no
  // homepage row, any non-home page with an order is preferred.
  let preferred = null;
  if (home) {
    const threshold = Math.ceil(minShareOfHome * home.exclude_confirmed.sessions - 1e-9);
    preferred = nonHome
      .filter((c) => c.exclude_confirmed.orders >= 1 && c.exclude_confirmed.sessions >= threshold)
      .sort(byVolume)[0];
  } else {
    preferred = nonHome.filter((c) => c.exclude_confirmed.orders >= 1).sort(byVolume)[0];
  }

  const chosen = preferred ?? home;
  if (!chosen) {
    return { status: 'skipped_no_page', reason: 'no homepage and no non-home page with an order' };
  }

  const q = chosen.exclude_confirmed;
  const shareOfHome =
    home && home.exclude_confirmed.sessions > 0 ? q.sessions / home.exclude_confirmed.sessions : null;
  const hits = await pageHits(ctx, site.idsite, [...byUrl.get(chosen.url).hsrs.keys()]);
  const evidence = {
    title: chosen.title,
    hits,
    home_sessions: home?.exclude_confirmed.sessions ?? 0,
    home_orders: home?.exclude_confirmed.orders ?? 0,
    share_of_home: shareOfHome,
    candidates: candidates.length,
    home_candidates: candidates.filter((c) => c.type === 'home').length,
    unfiltered: { ...chosen.none },
  };

  if (hits < minHits) {
    return {
      status: 'skipped_volume',
      idsitehsr: Number(chosen.hsr),
      url: chosen.url,
      pageType: chosen.type,
      entrySessions: q.sessions,
      orders: q.orders,
      revenue: q.revenue,
      reason: `gate: hits ${hits} >= ${minHits} on the page in the window`,
      evidence,
    };
  }

  return {
    status: 'qualified',
    idsitehsr: Number(chosen.hsr),
    url: chosen.url,
    pageType: chosen.type,
    entrySessions: q.sessions,
    orders: q.orders,
    revenue: q.revenue,
    reason: preferred ? 'preferred non-home page' : 'homepage',
    evidence,
  };
}
