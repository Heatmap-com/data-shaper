import { sessionOf } from '../adapters/_lib/session-stream.js';
import { mondayOf } from '../triggers/time.js';

/**
 * The fetchSessionRows row for a closed visit. With `idsitehsr`, the row
 * carries that page's scroll, pageviews, and capped time, as
 * fetchSessionRows(ctx, idsite, {idsitehsr}) does; the scan must have read
 * that page's facts.
 * @param {import('./open-visits.js').ScanVisit} visit
 * @param {Parameters<typeof sessionOf>[1]} bot
 * @param {{idsitehsr?: number}} [opts]
 */
export function sessionRowOf(visit, bot, opts = {}) {
  const row = baseRowOf(visit, bot);
  if (!Number.isInteger(opts.idsitehsr)) return row;
  const facts = visit.pageFacts.get(String(opts.idsitehsr));
  return {
    ...row,
    scrollMax: facts?.scrollMax ?? 0,
    landingPageviews: facts?.landingPageviews ?? 0,
    pageCappedMs: facts?.pageCappedMs ?? 0,
  };
}

/**
 * The idsitehsr of the visit's second pageview by server time, or null for
 * a single-pageview visit.
 * @param {import('./open-visits.js').ScanVisit} visit
 */
export function secondHsrOf(visit) {
  return visit.firstPages[1]?.[2] ?? null;
}

/**
 * The visit's UTMs as the window queries read them: its first session-tag
 * value, else its custom variable (tagUtmCte in src/adapters/_lib/sql.js).
 * @param {import('./open-visits.js').ScanVisit} visit
 */
function utmOf(visit) {
  return {
    source: visit.tagUtmSource || visit.utmSource,
    medium: visit.tagUtmMedium || visit.utmMedium,
    campaign: visit.tagUtmCampaign || visit.utmCampaign,
  };
}

/**
 * @param {import('./open-visits.js').ScanVisit} visit
 * @param {Parameters<typeof sessionOf>[1]} bot
 */
function baseRowOf(visit, bot) {
  let revenue = 0;
  for (const value of visit.orders.values()) revenue += value;
  return sessionOf({
    idvisit: visit.idvisit,
    firstDate: visit.firstDate,
    week: mondayOf(visit.firstDate),
    device: visit.device,
    referer: visit.referer,
    returning: visit.returning,
    entryHsr: visit.entryHsr,
    country: visit.country,
    browser: visit.browser,
    utmSource: utmOf(visit).source,
    fpHash: visit.fpHash,
    pageviews: visit.pageviewRows,
    cappedMs: visit.cappedMs,
    sawProduct: visit.events.has('product_viewed'),
    sawAtc: visit.events.has('add_to_cart'),
    sawCheckout: visit.events.has('checkout_started'),
    sawPurchase: visit.events.has('checkout_completed'),
    orders: visit.orders.size,
    revenue,
  }, bot);
}

/**
 * The loadTriggerFacts arrays for closed visits, in the shape
 * assembleSessions reads. Each visit's distinct pages become one row per
 * page; its scroll maximum and capped time ride on the first, which
 * assembleSessions folds back to the same per-visit values.
 *
 * @param {import('./open-visits.js').ScanVisit[]} visits
 * @param {Set<string>} [eventNames] the trigger predicate events; others are left out
 */
export function triggerInputsOf(visits, eventNames) {
  const out = { visits: [], pageviews: [], clicks: [], events: [], orders: [], tags: new Map() };
  for (const visit of visits) {
    const utm = utmOf(visit);
    out.visits.push({
      idvisit: visit.idvisit,
      server_date: visit.firstDate,
      started_at: visit.startedAt,
      config_id: visit.configId,
      device: visit.device,
      referer: visit.referer,
      returning: visit.returning,
      country: visit.country,
      entry_hsr: visit.entryHsr,
      utm_source: utm.source,
      referer_name: visit.refererName,
      utm_medium: utm.medium,
      utm_campaign: utm.campaign,
    });
    let first = true;
    for (const hsr of visit.hsrs) {
      out.pageviews.push({
        idvisit: visit.idvisit,
        hsr,
        scrollMax: first ? visit.scrollMax : 0,
        cappedMs: first ? visit.cappedMs : 0,
      });
      first = false;
    }
    if (visit.clicks > 0) out.clicks.push({ idvisit: visit.idvisit, clicks: visit.clicks });
    for (const eventType of visit.events) {
      if (!eventNames || eventNames.has(eventType)) out.events.push({ idvisit: visit.idvisit, eventType });
    }
    if (visit.orders.size > 0) {
      let revenue = 0;
      for (const value of visit.orders.values()) revenue += value;
      out.orders.push({ idvisit: visit.idvisit, orders: visit.orders.size, revenue });
    }
    if (visit.tags) out.tags.set(visit.idvisit, visit.tags);
  }
  return out;
}
