import { deviceName } from '../_lib/dims.js';
import { pageMemo } from '../_lib/page-memo.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';
import { PAGE_VISITS } from '../_lib/sql.js';
import { fetchHsrUrls } from '../_lib/urls.js';
import { pageType } from '../../page-type.js';

/**
 * journey-weekly: session-grain journey flags and path clusters for sessions
 * that viewed the page at any point (entry or internal), from pageview order
 * plus journey_events_map. Flag rows carry share_of_sessions per
 * (week, device, bot filter); path_cluster rows carry the top 10
 * <entry_type>→<second_type> clusters per (week, bot filter) with orders
 * and revenue. H20, H04.
 */

const CLUSTER_TOP_N = 10;

const FLAGS = [
  'entered_on_page',
  'saw_price',
  'saw_proof',
  'saw_offer',
  'saw_cart',
  'saw_policy',
  'multi_pdp',
  'u_turn',
  'back_within_10s',
];

export const adapter = {
  id: 'journey-weekly',
  dependsOn: [],
  scope: 'page',
  sessions: 'viewed',
  provides: ['H20', 'H04'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const [sessions, sequences, urls] = await Promise.all([
      fetchSessionRows(ctx, page.idsite, { viewed: true }),
      getTimedPageviewSequences(ctx, page),
      fetchHsrUrls(ctx, page.idsite),
    ]);
    const hsr = String(page.idsitehsr);

    const typeOf = (pv) => pageType(urls.get(pv.hsr) ?? '');

    /** @type {Map<string, object>} flag cells: week|device|filter|flag -> {den, num} */
    const flagCells = new Map();
    /** @type {Map<string, object>} cluster cells: week|filter|cluster -> {sessions, orders, revenue} */
    const clusterCells = new Map();
    /** @type {Map<string, number>} denominators: week|device|filter -> in-scope sessions */
    const denominators = new Map();

    let scoped = 0;
    for (const s of sessions) {
      const path = sequences.get(s.idvisit) ?? [];
      if (path.length === 0) continue;
      if (!path.some((pv) => pv.hsr === hsr)) continue;
      scoped += 1;

      const flags = computeFlags(s, path, hsr, typeOf, urls);
      for (const filter of filtersFor(s.tier)) {
        const denKey = `${s.week}|${deviceName(s.device)}|${filter}`;
        denominators.set(denKey, (denominators.get(denKey) ?? 0) + 1);
        for (const flag of FLAGS) {
          if (!flags[flag]) continue;
          const key = `${denKey}|${flag}`;
          let cell = flagCells.get(key);
          if (!cell) {
            cell = { week: s.week, device: deviceName(s.device), filter, flag, count: 0 };
            flagCells.set(key, cell);
          }
          cell.count += 1;
        }
        if (path.length >= 2) {
          const cluster = `${typeOf(path[0])}->${typeOf(path[1])}`;
          const key = `${s.week}|${filter}|${cluster}`;
          let cell = clusterCells.get(key);
          if (!cell) {
            cell = { week: s.week, filter, cluster, sessions: 0, orders: 0, revenue: 0 };
            clusterCells.set(key, cell);
          }
          cell.sessions += 1;
          cell.orders += s.orders;
          cell.revenue += s.revenue;
        }
      }
    }

    const rows = [];
    for (const cell of flagCells.values()) {
      const den = denominators.get(`${cell.week}|${cell.device}|${cell.filter}`) ?? 0;
      rows.push({
        dims: { week: cell.week, device: cell.device, bot_filter: cell.filter, flag: cell.flag },
        metrics: {
          sessions: cell.count,
          share_of_sessions: den > 0 ? round4(cell.count / den) : null,
        },
      });
    }

    /** @type {Map<string, Array<object>>} week|filter -> clusters */
    const clustersByCell = new Map();
    for (const cell of clusterCells.values()) {
      const key = `${cell.week}|${cell.filter}`;
      let list = clustersByCell.get(key);
      if (!list) {
        list = [];
        clustersByCell.set(key, list);
      }
      list.push(cell);
    }
    for (const list of clustersByCell.values()) {
      list.sort((a, b) => b.sessions - a.sessions || (a.cluster < b.cluster ? -1 : 1));
      for (const cell of list.slice(0, CLUSTER_TOP_N)) {
        rows.push({
          dims: { week: cell.week, bot_filter: cell.filter, cluster: cell.cluster },
          metrics: {
            sessions: cell.sessions,
            orders: cell.orders,
            revenue_udp: round2(cell.revenue),
          },
        });
      }
    }

    return {
      id: adapter.id,
      rows,
      notes: {
        journey_scope: 'sessions that viewed the page at any point (entry or internal); entry vs internal from entry_hsr',
        back_within_10s_definition:
          'a non-adjacent repeat of an earlier pageview hsr within 10 s of that earlier view',
        journey_sessions_scoped: scoped,
      },
    };
  },
};

/**
 * Per-session flags from the ordered pageview path.
 * @param {object} s session row
 * @param {Array<{idloghsr: string, hsr: string, tsMs: number}>} path
 * @param {string} hsr the page's idsitehsr
 * @param {(pv: object) => string} typeOf
 * @param {Map<string, string>} urls
 */
function computeFlags(s, path, hsr, typeOf, urls) {
  const flags = {
    entered_on_page: s.entryHsr === hsr,
    saw_price: false,
    saw_proof: false,
    saw_offer: false,
    saw_cart: s.sawCheckout,
    saw_policy: false,
    multi_pdp: false,
    u_turn: false,
    back_within_10s: false,
  };
  const productHsrs = new Set();
  const firstSeenAt = new Map();
  for (let i = 0; i < path.length; i += 1) {
    const pv = path[i];
    const type = typeOf(pv);
    const url = (urls.get(pv.hsr) ?? '').toLowerCase();
    const seen = firstSeenAt.get(pv.hsr);
    if (seen != null && i - seen.idx > 1) {
      flags.u_turn = true;
      if (pv.tsMs - seen.tsMs <= 10000) flags.back_within_10s = true;
    }
    if (seen == null) firstSeenAt.set(pv.hsr, { idx: i, tsMs: pv.tsMs });
    if (type === 'product') productHsrs.add(pv.hsr);
    if (/\/reviews/.test(url) || /#reviews\//.test(url)) flags.saw_proof = true;
    if (type === 'content' && url.includes('review')) flags.saw_proof = true;
    if (/offer|sale|discount/.test(url)) flags.saw_offer = true;
    if (type === 'cart') flags.saw_cart = true;
    if ((type === 'account' || type === 'other') && /return|shipping|policy/.test(url)) {
      flags.saw_policy = true;
    }
  }
  flags.multi_pdp = productHsrs.size >= 2;
  return flags;
}

/**
 * Pageview sequences with timestamps of the visits that entered or viewed
 * the page, memoized per page. getPageviewSequences in _lib/clicks.js stops
 * at (idloghsr, hsr); the journey flags need server_time for the
 * back-within-10s read, so this dataset carries its own query.
 *
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 * @returns {Promise<Map<string, Array<{idloghsr: string, hsr: string, tsMs: number}>>>}
 */
async function getTimedPageviewSequences(ctx, page) {
  return pageMemo(ctx, `journey-pvs:${page.idsite}:${page.idsitehsr}`, async () => {
    const rows = await ctx.gateway.query(
      `SELECT toString(idvisit) AS idvisit,
              toString(idloghsr) AS idloghsr,
              toString(idsitehsr) AS hsr,
              toUInt64(toUnixTimestamp(server_time)) * 1000 AS ts_ms
         FROM default.udp_hsrce_pageviews
        WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
          AND CAST(idvisit AS UInt64) IN ${PAGE_VISITS}
        ORDER BY idvisit, server_time, idloghsr`,
      { idsite: page.idsite, idsitehsr: page.idsitehsr, w0: ctx.windowStart, w1: ctx.windowEnd },
      'journey-weekly:pageviews',
    );
    /** @type {Map<string, Array<{idloghsr: string, hsr: string, tsMs: number}>>} */
    const byVisit = new Map();
    for (const r of rows) {
      const seq = byVisit.get(r.idvisit) ?? [];
      seq.push({ idloghsr: r.idloghsr, hsr: r.hsr, tsMs: Number(r.ts_ms ?? 0) });
      byVisit.set(r.idvisit, seq);
    }
    return byVisit;
  });
}

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/** @param {number} n */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}
