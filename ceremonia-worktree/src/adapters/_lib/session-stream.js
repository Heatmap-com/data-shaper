import { applySafety, getBotContext } from './bot-context.js';
import { EVENTS_CTE, ORDERS_CTE, PAGES_CTE, SCROLL_CTE, fpHashExpr, VISITS_CTE } from './sql.js';

/**
 * One row per session of the site in the batch window, with the fields the
 * session-level datasets share: entry page, fingerprint hash, funnel flags,
 * deduplicated orders, visit pageviews, and optionally the chosen page's
 * scroll and per-page time. Bot tiers are applied per session by the caller
 * through the returned rows' `tier` field.
 */

/**
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @param {{idsitehsr?: number, viewed?: boolean}} [opts] pass idsitehsr to attach the chosen
 *   page's scroll depth and on-page time per session. `viewed` says the
 *   caller reads sessions that viewed the page anywhere, not only entry
 *   sessions; the window query returns every session either way.
 *
 * When the run context carries a `sessionSource` (the day scan's page pass),
 * the rows come from it: the sessions of the page the context is for, the
 * same rows this query returns for them.
 */
export async function fetchSessionRows(ctx, idsite, opts = {}) {
  if (ctx.sessionSource) return ctx.sessionSource.rows(idsite, opts);
  const withScroll = Number.isInteger(opts.idsitehsr);
  const sql = `
WITH
${VISITS_CTE},
${EVENTS_CTE},
${ORDERS_CTE},
${PAGES_CTE}
${withScroll ? `,${SCROLL_CTE}` : ''}
SELECT
    toString(v.idvisit) AS idvisit,
    toString(v.first_date) AS first_date,
    toString(v.week_start) AS week,
    v.device_type AS device,
    v.referer_type AS referer,
    v.visitor_returning AS returning,
    v.entry_hsr AS entry_hsr,
    v.location_country AS country,
    v.config_browser_name AS browser,
    toString(${fpHashExpr('v')}) AS fp_hash,
    v.utm_source AS utm_source,
    ifNull(p.pageviews, 0) AS pageviews,
    ifNull(p.capped_ms, 0) AS capped_ms,
    ifNull(e.saw_product, 0) AS saw_product,
    ifNull(e.saw_atc, 0) AS saw_atc,
    ifNull(e.saw_checkout, 0) AS saw_checkout,
    ifNull(e.saw_purchase, 0) AS saw_purchase,
    ifNull(o.orders_udp, 0) AS orders,
    ifNull(o.revenue_udp, 0) AS revenue
    ${withScroll ? `,
    ifNull(s.scroll_max, 0) AS scroll_max,
    ifNull(s.landing_pageviews, 0) AS landing_pageviews,
    ifNull(s.page_capped_ms, 0) AS page_capped_ms` : ''}
FROM visits v
LEFT JOIN events e ON e.idsite = v.idsite AND e.idvisit = v.idvisit
LEFT JOIN orders o ON o.idvisit = v.idvisit
LEFT JOIN pages p ON p.idvisit = v.idvisit
${withScroll ? 'LEFT JOIN scroll s ON s.idvisit = v.idvisit' : ''}
`;
  const params = { idsite, w0: ctx.windowStart, w1: ctx.windowEnd };
  if (withScroll) params.idsitehsr = opts.idsitehsr;
  const raw = await ctx.gateway.query(sql, params, withScroll ? 'sessions:entry+scroll' : 'sessions:entry');

  const bot = await getBotContext(ctx, idsite);
  return raw.map((r) => ({
    ...sessionOf({
      idvisit: r.idvisit,
      firstDate: r.first_date,
      week: r.week,
      device: Number(r.device),
      referer: Number(r.referer),
      returning: Number(r.returning),
      entryHsr: String(r.entry_hsr ?? ''),
      country: String(r.country ?? ''),
      browser: String(r.browser ?? ''),
      utmSource: String(r.utm_source ?? ''),
      fpHash: r.fp_hash,
      pageviews: Number(r.pageviews),
      cappedMs: Number(r.capped_ms),
      sawProduct: Number(r.saw_product) === 1,
      sawAtc: Number(r.saw_atc) === 1,
      sawCheckout: Number(r.saw_checkout) === 1,
      sawPurchase: Number(r.saw_purchase) === 1,
      orders: Number(r.orders),
      revenue: Number(r.revenue),
    }, bot),
    ...(withScroll
      ? {
          scrollMax: Number(r.scroll_max),
          landingPageviews: Number(r.landing_pageviews),
          pageCappedMs: Number(r.page_capped_ms),
        }
      : {}),
  }));
}

/**
 * One session row from its visit fields, with the bot tier of its
 * fingerprint week and the commerce-signal rescue applied. The window query
 * and the day scan both build their rows here.
 *
 * @param {{idvisit: string, firstDate: string, week: string, device: number, referer: number,
 *   returning: number, entryHsr: string, country: string, browser: string, utmSource: string,
 *   fpHash: string, pageviews: number, cappedMs: number, sawProduct: boolean, sawAtc: boolean,
 *   sawCheckout: boolean, sawPurchase: boolean, orders: number, revenue: number}} fields
 * @param {{tierOf: (week: string, fpHash: string) => {tier: string, reasons: string[]} | null}} bot
 */
export function sessionOf(fields, bot) {
  const { fpHash, ...session } = fields;
  const fp = bot.tierOf(fields.week, fpHash);
  const safety = applySafety(
    fp?.tier ?? null,
    fp?.reasons ?? [],
    fields.sawAtc,
    fields.sawCheckout,
    fields.sawPurchase,
    fields.orders,
  );
  return { ...session, tier: safety.tier, rescued: safety.rescued };
}

/**
 * The filter tiers a session counts toward: always 'none', plus
 * 'exclude_confirmed' unless the session's fingerprint was confirmed bot.
 * @param {string | null} tier
 * @returns {string[]}
 */
export function filtersFor(tier) {
  return tier !== 'confirmed' ? ['none', 'exclude_confirmed'] : ['none'];
}
