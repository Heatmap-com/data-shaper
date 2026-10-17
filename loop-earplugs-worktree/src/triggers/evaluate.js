import { addDays, dayDiff } from './time.js';

/**
 * Session and visitor predicates. Every threshold is read from the trigger
 * predicate. Comparisons that the registry describes as strictly greater-than
 * use `>`.
 */

/** @param {object} predicate @param {string} key */
function required(predicate, key) {
  if (predicate == null || predicate[key] == null) {
    throw new Error(`trigger predicate is missing ${key}`);
  }
  return predicate[key];
}

/**
 * Purchase, as the abandoned-cart predicate defines it. The journey event
 * name is whatever `purchase_events` lists (the live name is
 * `checkout_completed`). An order row counts when
 * `purchase_also_counts_order` is true.
 * @param {object} predicate
 * @param {{ events?: string[], orders?: number }} session
 */
export function sessionPurchased(predicate, session) {
  const events = new Set(session.events ?? []);
  if (required(predicate, 'purchase_events').some((name) => events.has(name))) return true;
  return Boolean(predicate.purchase_also_counts_order) && Number(session.orders) > 0;
}

/**
 * Abandoned cart: an intent event, and no purchase. Intent events come from
 * the predicate (`add_to_cart` and `checkout_started` in the shipped
 * definition, which is the analysis definition this trigger renames).
 * @param {object} predicate
 * @param {{ events?: string[], orders?: number }} session
 */
export function abandonedCart(predicate, session) {
  if (predicate.type !== 'session_events') return false;
  const events = new Set(session.events ?? []);
  const intent = required(predicate, 'intent_events').some((name) => events.has(name));
  return intent && !sessionPurchased(predicate, session);
}

/**
 * Showed interest: distinct pages > min_pages, OR clicks, scroll, and
 * duration each strictly greater than their thresholds.
 * @param {object} predicate
 * @param {{ pageviews?: number, clicks?: number, scrollPct?: number, durationSec?: number }} session
 */
export function showedInterest(predicate, session) {
  if (predicate.type !== 'session_interest') return false;
  const pages = Number(session.pageviews) || 0;
  const clicks = Number(session.clicks) || 0;
  const scroll = Number(session.scrollPct) || 0;
  const duration = Number(session.durationSec) || 0;
  if (pages > required(predicate, 'min_pages')) return true;
  return (
    clicks > required(predicate, 'min_clicks')
    && scroll > required(predicate, 'min_scroll_pct')
    && duration > required(predicate, 'min_duration_sec')
  );
}

/**
 * @param {object} session
 * @param {object} other
 */
function isBefore(session, other) {
  if (session.startedAt != null && other.startedAt != null) {
    if (session.startedAt !== other.startedAt) return session.startedAt < other.startedAt;
  } else if (session.serverDate !== other.serverDate) {
    return session.serverDate < other.serverDate;
  }
  return String(session.idvisit) < String(other.idvisit);
}

/**
 * Super-Shopper inside the rolling window ending on asOf. A day is inside
 * the window when 0 <= asOf - serverDate <= window_days.
 * The cart-or-products clause is waived for a prior purchaser who returns
 * and triggers showed interest.
 * @param {object} args
 * @param {object} args.predicate
 * @param {object} args.interestPredicate showed-interest predicate named by the config
 * @param {object} args.purchasePredicate abandoned-cart predicate, for what counts as a purchase
 * @param {object[]} args.sessions this visitor's sessions, including lookback
 * @param {string} args.asOf YYYY-MM-DD
 */
export function superShopper({ predicate, interestPredicate, purchasePredicate, sessions, asOf }) {
  if (predicate.type !== 'visitor_window') return false;
  const windowDays = required(predicate, 'window_days');
  const lookback = required(predicate, 'prior_purchase_lookback_days');
  const inWindow = sessions.filter((session) => {
    const gap = dayDiff(asOf, session.serverDate);
    return gap >= 0 && gap <= windowDays;
  });
  if (new Set(inWindow.map((session) => session.idvisit)).size < required(predicate, 'min_sessions')) {
    return false;
  }
  const interested = inWindow.filter((session) => showedInterest(interestPredicate, session));
  if (interested.length < required(predicate, 'min_interest_sessions')) return false;
  const atcEvent = required(predicate, 'atc_event');
  const atcSessions = inWindow.filter((session) => (session.events ?? []).includes(atcEvent)).length;
  const products = new Set(inWindow.flatMap((session) => session.productPages ?? []));
  if (atcSessions >= required(predicate, 'min_atc_sessions')) return true;
  if (products.size >= required(predicate, 'min_product_pages')) return true;
  const firstInterest = interested.reduce((earliest, session) => (
    isBefore(session, earliest) ? session : earliest
  ));
  return sessions.some((session) => {
    const gap = dayDiff(asOf, session.serverDate);
    if (gap < 0 || gap > lookback) return false;
    if (!sessionPurchased(purchasePredicate, session)) return false;
    return isBefore(session, firstInterest);
  });
}

/**
 * Predicate type to evaluator. A new trigger kind is one entry here.
 * @type {Readonly<Record<string, (predicate: object, session: object, ctx: { interest?: object, purchase?: object, sessions?: object[], asOf?: string }) => boolean>>}
 */
const PREDICATES = Object.freeze({
  session_events: (predicate, session) => abandonedCart(predicate, session),
  session_interest: (predicate, session) => showedInterest(predicate, session),
  visitor_window: (predicate, session, ctx) => superShopper({
    predicate,
    interestPredicate: ctx.interest,
    purchasePredicate: ctx.purchase,
    sessions: ctx.sessions ?? [],
    asOf: ctx.asOf,
  }),
});

export const PREDICATE_TYPES = Object.freeze(Object.keys(PREDICATES));

/**
 * @param {object} definition
 * @param {object} session
 * @param {{ interest?: object, purchase?: object, sessions?: object[], asOf?: string }} [ctx]
 */
export function qualifies(definition, session, ctx = {}) {
  const predicate = definition.predicate;
  const evaluate = Object.hasOwn(PREDICATES, predicate.type) ? PREDICATES[predicate.type] : null;
  if (!evaluate) throw new Error(`unknown predicate type "${predicate.type}"`);
  return evaluate(predicate, session, ctx);
}

/**
 * Follow one hit forward. Later sessions share config_id, start after the
 * hit, and fall on a day at most window_days after the hit, on or before asOf.
 * An empty config_id does not chain: blank ids are not the same visitor.
 * `recovered` follows the hit predicate's `recover` flag.
 * @param {object} hit
 * @param {object} predicate the hit's predicate, including chain_window_days and recover
 * @param {object} purchasePredicate
 * @param {object[]} sessions
 * @param {string} asOf
 */
export function chainOutcome(hit, predicate, purchasePredicate, sessions, asOf) {
  const windowDays = required(predicate, 'chain_window_days');
  const later = (hit.configId ? sessions : []).filter((session) => {
    if (session.configId !== hit.configId) return false;
    if (String(session.idvisit) === String(hit.idvisit)) return false;
    if (dayDiff(asOf, session.serverDate) < 0) return false;
    const gap = dayDiff(session.serverDate, hit.serverDate);
    if (gap < 0 || gap > windowDays) return false;
    return isBefore(hit, session);
  }).sort((a, b) => (isBefore(a, b) ? -1 : 1));
  const purchaseAt = later.findIndex((session) => sessionPurchased(purchasePredicate, session));
  const purchased = purchaseAt >= 0;
  const purchase = purchased ? later[purchaseAt] : null;
  const revenue = later.reduce((sum, session) => sum + (Number(session.revenue) || 0), 0);
  let seconds = 0;
  if (purchased && hit.startedAt != null && purchase.startedAt != null && purchase.startedAt >= hit.startedAt) {
    seconds = Math.round((purchase.startedAt - hit.startedAt) / 1000);
  }
  return {
    returned: later.length > 0,
    sessionsUntilReturn: later.length > 0 ? 1 : 0,
    sessionsUntilPurchase: purchased ? purchaseAt + 1 : 0,
    purchased,
    revenue,
    secondsToPurchase: seconds,
    recovered: Boolean(predicate.recover) && purchased,
    windowDays,
    windowCloses: addDays(hit.serverDate, windowDays),
    final: dayDiff(asOf, hit.serverDate) >= windowDays,
  };
}
