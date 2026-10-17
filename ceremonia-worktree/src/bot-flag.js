/**
 * Bot fingerprint rules, a port of
 * ~/Work/User-Journey-analysis/data/extract3/bot_flag.py.
 * Thresholds are the extract-3 values; this module does not tune them.
 *
 * A fingerprint is (location_country, location_city, config_resolution,
 * config_browser_name, config_browser_version, config_device_type) for the
 * visit's site and Monday week. Classification happens per fingerprint;
 * the safety rule can then clear an individual session's flag.
 *
 * @typedef {'confirmed'|'suspect'|null} BotTier
 */

export const DATACENTER_CITIES = [
  'ashburn',
  'boardman',
  'council bluffs',
  'the dalles',
  'santa clara',
  'columbus',
  'quincy',
];

// Fingerprint-week, at the session's own site.
export const MIN_FINGERPRINT_SESSIONS = 200;
export const MAX_ATC_PER_PRODUCT_VIEW = 0.002;
export const MIN_SINGLE_PAGEVIEW_SHARE = 0.85;

// Extra signals. Confirmed needs the base conditions plus at least one.
export const MIN_FLEET_SITES_ZERO_ORDERS = 20;
export const MIN_VERSION_SHARE_THIS_WEEK = 0.3;
export const MAX_VERSION_SHARE_PRIOR_4_WEEKS = 0.02;
export const PRIOR_WEEKS = 4;

// Output floors. These are not bot thresholds.
export const COHORT_FINGERPRINT_KEEP_SESSIONS = 50;
export const FLEET_FINGERPRINT_KEEP_SESSIONS = 500;

/** @param {string| null | undefined} city */
export function normCity(city) {
  return (city || '').trim().toLowerCase().split(/\s+/).join(' ');
}

/** @param {string | null | undefined} city */
export function isDatacenterCity(city) {
  return DATACENTER_CITIES.includes(normCity(city));
}

/** @param {string | null | undefined} resolution */
export function isSquareResolution(resolution) {
  const text = (resolution || '').trim().toLowerCase().replace(/×/g, 'x').replace(/\s+/g, '');
  if (!text.includes('x')) return false;
  const [width, height] = text.split('x', 2);
  const w = Number.parseInt(width, 10);
  const h = Number.parseInt(height, 10);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return false;
  return w > 0 && w === h;
}

/**
 * Volume, zero orders, low add-to-cart rate, high single-pageview share.
 *
 * product_viewed_sessions = 0 and add_to_cart_sessions = 0 is treated as a
 * ratio of 0, which is below 0.002. product_viewed_sessions = 0 and
 * add_to_cart_sessions > 0 does not meet the ratio.
 *
 * @param {number} sessions
 * @param {number} orders
 * @param {number} atcSessions
 * @param {number} productViewedSessions
 * @param {number} singlePageviewSessions
 */
export function baseConditions(sessions, orders, atcSessions, productViewedSessions, singlePageviewSessions) {
  if (sessions < MIN_FINGERPRINT_SESSIONS || orders !== 0) return false;
  if (productViewedSessions <= 0) {
    if (atcSessions !== 0) return false;
  } else if (atcSessions / productViewedSessions >= MAX_ATC_PER_PRODUCT_VIEW) {
    return false;
  }
  if (sessions <= 0 || singlePageviewSessions / sessions < MIN_SINGLE_PAGEVIEW_SHARE) return false;
  return true;
}

/**
 * True when this week's browser_version share is high and the prior 4 weeks are not.
 *
 * prior_sessions = 0 means the prior share is undefined and the spike is false.
 *
 * @param {number | null} shareThisWeek
 * @param {number | null} sharePrior4Weeks
 * @param {number} priorSessions
 */
export function versionSpike(shareThisWeek, sharePrior4Weeks, priorSessions) {
  if (priorSessions <= 0 || shareThisWeek == null || sharePrior4Weeks == null) return false;
  return shareThisWeek >= MIN_VERSION_SHARE_THIS_WEEK && sharePrior4Weeks < MAX_VERSION_SHARE_PRIOR_4_WEEKS;
}

/**
 * @param {boolean} square
 * @param {boolean} datacenter
 * @param {number} fleetZeroOrderSites
 * @param {boolean} spiked
 * @returns {string[]}
 */
export function fingerprintReasons(square, datacenter, fleetZeroOrderSites, spiked) {
  /** @type {string[]} */
  const reasons = [];
  if (square) reasons.push('square_resolution');
  if (datacenter) reasons.push('datacenter_city');
  if (fleetZeroOrderSites >= MIN_FLEET_SITES_ZERO_ORDERS) reasons.push('fleet_20_sites_zero_orders');
  if (spiked) reasons.push('browser_version_spike');
  return reasons;
}

/**
 * @param {boolean} base
 * @param {string[]} reasons
 * @param {boolean} [peerMode] ignores browser_version_spike; caller filters reasons first
 * @returns {{ tier: BotTier, reasons: string[] }}
 */
export function fingerprintTier(base, reasons, peerMode = false) {
  void peerMode;
  if (!base) return { tier: null, reasons: [] };
  if (reasons.length > 0) return { tier: 'confirmed', reasons: [...reasons] };
  return { tier: 'suspect', reasons: ['base_only'] };
}

/**
 * A session with add-to-cart, checkout, or an order is never flagged.
 *
 * @param {BotTier} tier
 * @param {string[]} reasons
 * @param {boolean} sawAtc
 * @param {boolean} sawCheckout
 * @param {boolean} sawPurchase
 * @param {number} orders
 * @returns {{ tier: BotTier, reasons: string[], rescued: boolean }}
 */
export function applySafety(tier, reasons, sawAtc, sawCheckout, sawPurchase, orders) {
  const hit = Boolean(sawAtc || sawCheckout || sawPurchase || orders);
  if (tier && hit) return { tier: null, reasons: [...reasons], rescued: true };
  return { tier, reasons: [...reasons], rescued: false };
}
