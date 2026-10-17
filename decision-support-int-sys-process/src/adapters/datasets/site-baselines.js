import { refererName } from '../_lib/dims.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';
import { mapState } from '../../scan/snapshot.js';

/**
 * site-baselines: the site's own entry-session baselines over the batch
 * window, per (Monday week, referrer group): entry sessions, the exit
 * share, the pogo share and RPS. Exit is approximated as single-pageview
 * sessions (the session stream carries pageview counts, not last-page
 * identity). Pogo is an entry session whose second pageview returns to
 * the entry hsr (a second-pageview lookup, one bounded query for the
 * whole site). A totals row per week (channel 'all') carries the
 * site-wide RPS everything else is compared against. H24, site scope.
 */

export const adapter = {
  id: 'site-baselines',
  dependsOn: [],
  scope: 'site',
  provides: ['H24'],
  pass: 'site',

  /**
   * @param {{idsite: number, siteName: string}} page site-level page arg
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const params = { idsite: page.idsite, w0: ctx.windowStart, w1: ctx.windowEnd };
    const [sessions, secondPages] = await Promise.all([
      fetchSessionRows(ctx, page.idsite),
      ctx.gateway.query(
        `SELECT idvisit, hsr
           FROM (
             SELECT toString(idvisit) AS idvisit,
                    toString(idsitehsr) AS hsr,
                    row_number() OVER (PARTITION BY idvisit ORDER BY server_time, idloghsr) AS rn
               FROM default.udp_hsrce_pageviews
              WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
           )
          WHERE rn = 2`,
        params,
        'site-baselines:second-pageview',
      ),
    ]);

    /** @type {Map<string, string>} idvisit -> second pageview's hsr */
    const secondHsrByVisit = new Map(secondPages.map((r) => [String(r.idvisit), String(r.hsr ?? '')]));
    const folder = adapter.open(page, ctx);
    folder.fold(sessions.map((s) => ({ ...s, secondHsr: secondHsrByVisit.get(s.idvisit) ?? null })));
    return folder.finish(page, ctx);
  },

  /**
   * Cells per (week, channel, bot filter). Each session row carries
   * `secondHsr`, its second pageview's page (null with one pageview); the
   * day scan's site pass puts it on the rows it folds.
   * @param {object} _page
   * @param {import('../../../ports/dataset.js').RunContext} _ctx
   */
  open(_page, _ctx) {
    /** @type {Map<string, object>} */
    const cells = new Map();
    const cellFor = (dims) => {
      const key = JSON.stringify(dims);
      let cell = cells.get(key);
      if (!cell) {
        cell = { dims, entrySessions: 0, exits: 0, pogos: 0, orders: 0, revenue: 0 };
        cells.set(key, cell);
      }
      return cell;
    };
    return {
      ...mapState(cells),
      /** @param {object[]} sessions */
      fold(sessions) {
        for (const s of sessions) {
          if (s.entryHsr === '' || s.entryHsr === '0') continue;
          const channel = refererName(s.referer);
          const pogo = s.secondHsr === s.entryHsr;
          for (const filter of filtersFor(s.tier)) {
            for (const ch of [channel, 'all']) {
              const cell = cellFor({ week: s.week, channel: ch, bot_filter: filter });
              cell.entrySessions += 1;
              if (s.pageviews === 1) cell.exits += 1;
              if (pogo) cell.pogos += 1;
              cell.orders += s.orders;
              cell.revenue += s.revenue;
            }
          }
        }
      },
      async finish() {
        return rowsOf(cells);
      },
    };
  },
};

/** @param {Map<string, object>} cells */
function rowsOf(cells) {
  const rows = [...cells.values()]
    .map((cell) => ({
      dims: { ...cell.dims },
      metrics: {
        entry_sessions: cell.entrySessions,
        exit_share: cell.entrySessions > 0 ? round4(cell.exits / cell.entrySessions) : 0,
        pogo_share: cell.entrySessions > 0 ? round4(cell.pogos / cell.entrySessions) : 0,
        orders_udp: cell.orders,
        revenue_udp: round2(cell.revenue),
        rps: cell.entrySessions > 0 ? round4(cell.revenue / cell.entrySessions) : 0,
      },
    }))
    .sort(
      (a, b) =>
        a.dims.week.localeCompare(b.dims.week) ||
        a.dims.channel.localeCompare(b.dims.channel) ||
        a.dims.bot_filter.localeCompare(b.dims.bot_filter),
    );

  return { id: adapter.id, rows };
}

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/** @param {number} n */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}
