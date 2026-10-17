import {
  COHORT_FINGERPRINT_KEEP_SESSIONS,
  PRIOR_WEEKS,
  applySafety,
  baseConditions,
  fingerprintReasons,
  fingerprintTier,
  isDatacenterCity,
  isSquareResolution,
  versionSpike,
} from '../../bot-flag.js';
import {
  EVENTS_CTE,
  FP_HASH_EXPR,
  ORDERS_CTE,
  PAGES_CTE,
  visitsCte,
} from './sql.js';

/**
 * Per-site bot classification, ported from extract-3's build_extract3.py:
 *
 * 1. Fingerprint-week aggregates at the session's own site. A fingerprint is
 *    (country, city, resolution, browser, browser_version, device) per Monday
 *    week. Fingerprints under COHORT_FINGERPRINT_KEEP_SESSIONS sessions never
 *    receive a tier (extract-3's "(other)" bucket).
 * 2. base_conditions per fingerprint. A base-true fingerprint is confirmed
 *    by a square resolution, a datacenter city, or a browser-version spike
 *    on this site. The fleet-wide zero-order scan is not run. Dead sessions
 *    (one page, zero clicks, zero scroll, no transaction) are excluded by
 *    the site's traffic-exclusion model, not by this fingerprint tier.
 * 3. Rule (d): browser_version share this Monday week vs the prior four,
 *    with a 28-day lookback before the window.
 *
 * The result is a tier lookup keyed by (Monday week, fp_hash). The per-session
 * safety rule (a session with add-to-cart, checkout, or an order is never
 * flagged) stays with the caller through applySafety.
 */

const VERSION_WEEKS_BACK = 7 * PRIOR_WEEKS;

/**
 * @param {string} iso
 * @param {number} days
 */
function shiftDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Port of fingerprint_sql(): per site-week fingerprint aggregates.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 */
async function fetchFingerprintAggregates(ctx, idsite) {
  const sql = `
WITH
${visitsCte()},
fp_n AS (
    SELECT idsite, week_start, location_country, location_city, config_resolution,
           config_browser_name, config_browser_version, device_type, count() AS n
    FROM visits
    GROUP BY idsite, week_start, location_country, location_city, config_resolution,
             config_browser_name, config_browser_version, device_type
),
${EVENTS_CTE},
${ORDERS_CTE},
${PAGES_CTE},
tagged AS (
    SELECT v.idsite AS idsite,
           v.week_start AS week_start,
           if(f.n >= ${COHORT_FINGERPRINT_KEEP_SESSIONS}, v.location_country, '(other)') AS location_country,
           if(f.n >= ${COHORT_FINGERPRINT_KEEP_SESSIONS}, v.location_city, '(other)') AS location_city,
           if(f.n >= ${COHORT_FINGERPRINT_KEEP_SESSIONS}, v.config_resolution, '(other)') AS config_resolution,
           if(f.n >= ${COHORT_FINGERPRINT_KEEP_SESSIONS}, v.config_browser_name, '(other)') AS config_browser_name,
           if(f.n >= ${COHORT_FINGERPRINT_KEEP_SESSIONS}, v.config_browser_version, '(other)') AS config_browser_version,
           if(f.n >= ${COHORT_FINGERPRINT_KEEP_SESSIONS}, toString(v.device_type), '(other)') AS device_type,
           if(f.n >= ${COHORT_FINGERPRINT_KEEP_SESSIONS}, ${FP_HASH_EXPR}, toUInt64(0)) AS fp_hash,
           ifNull(e.saw_product, 0) AS saw_product,
           ifNull(e.saw_atc, 0) AS saw_atc,
           ifNull(o.orders_udp, 0) AS orders_udp,
           ifNull(p.pageviews, 0) AS pageviews
    FROM visits v
    INNER JOIN fp_n f
        ON f.idsite = v.idsite AND f.week_start = v.week_start
       AND f.location_country = v.location_country AND f.location_city = v.location_city
       AND f.config_resolution = v.config_resolution AND f.config_browser_name = v.config_browser_name
       AND f.config_browser_version = v.config_browser_version AND f.device_type = v.device_type
    LEFT JOIN events e ON e.idsite = v.idsite AND e.idvisit = v.idvisit
    LEFT JOIN orders o ON o.idvisit = v.idvisit
    LEFT JOIN pages p ON p.idvisit = v.idvisit
)
SELECT toString(week_start) AS week, location_country AS country, location_city AS city,
       config_resolution AS resolution, config_browser_name AS browser,
       config_browser_version AS version, device_type AS device, toString(any(fp_hash)) AS fp_hash,
       count() AS sessions,
       countIf(pageviews = 1) AS single_pageview_sessions,
       countIf(saw_product = 1) AS product_viewed_sessions,
       countIf(saw_atc = 1) AS add_to_cart_sessions,
       sum(orders_udp) AS orders_udp
FROM tagged
GROUP BY week_start, location_country, location_city, config_resolution,
         config_browser_name, config_browser_version, device_type
`;
  const rows = await ctx.gateway.query(sql, { idsite, w0: ctx.windowStart, w1: ctx.windowEnd }, 'bot:fingerprints');
  /** @type {Map<string, object>} keyed by `${week}|${fpHash}` */
  const kept = new Map();
  let longTailSessions = 0;
  for (const r of rows) {
    if (r.country === '(other)') {
      longTailSessions += Number(r.sessions);
      continue;
    }
    kept.set(`${r.week}|${r.fp_hash}`, {
      week: r.week,
      fpHash: r.fp_hash,
      sessions: Number(r.sessions),
      single: Number(r.single_pageview_sessions),
      product: Number(r.product_viewed_sessions),
      atc: Number(r.add_to_cart_sessions),
      orders: Number(r.orders_udp),
      city: r.city,
      resolution: r.resolution,
      version: r.version,
    });
  }
  return { kept, longTailSessions };
}

/**
 * Rule (d) denominators: per site-week browser_version session counts over the
 * window and a lookback deep enough to cover the prior four Monday weeks.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 */
async function fetchVersionShares(ctx, idsite) {
  const lookback0 = shiftDays(ctx.windowStart, -VERSION_WEEKS_BACK);
  const counts = new Map(); // `${week}|${version}` -> sessions
  const siteWeek = new Map(); // `${week}` -> sessions
  for (const [w0, w1, label] of [
    [ctx.windowStart, ctx.windowEnd, 'bot:version-shares'],
    [lookback0, ctx.windowEnd, 'bot:version-lookback'],
  ]) {
    const rows = await ctx.gateway.query(
      `WITH ${visitsCte()}
       SELECT toString(week_start) AS week, config_browser_version AS version, count() AS sessions
       FROM visits GROUP BY week, version`,
      { idsite, w0, w1 },
      label,
    );
    for (const r of rows) {
      const key = `${r.week}|${r.version ?? ''}`;
      counts.set(key, Number(r.sessions));
      siteWeek.set(r.week, (siteWeek.get(r.week) ?? 0) + Number(r.sessions));
    }
  }
  return { counts, siteWeek };
}

/**
 * @param {Map<string, number>} counts
 * @param {Map<string, number>} siteWeek
 * @param {string} week
 * @param {string} version
 */
function thisVersionShare(counts, siteWeek, week, version) {
  const total = siteWeek.get(week) ?? 0;
  if (total <= 0) return null;
  return (counts.get(`${week}|${version}`) ?? 0) / total;
}

/**
 * @param {Map<string, number>} counts
 * @param {Map<string, number>} siteWeek
 * @param {string} week
 * @param {string} version
 */
function priorVersionShare(counts, siteWeek, week, version) {
  let ver = 0;
  let tot = 0;
  for (let i = 1; i <= PRIOR_WEEKS; i += 1) {
    const prev = shiftDays(week, -7 * i);
    ver += counts.get(`${prev}|${version}`) ?? 0;
    tot += siteWeek.get(prev) ?? 0;
  }
  if (tot <= 0) return { share: null, sessions: 0 };
  return { share: ver / tot, sessions: tot };
}

/**
 * Builds (or returns the memoized) bot context for a site. Memoized on
 * ctx.batchNotes so every dataset for one site shares one classification.
 *
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 */
export async function getBotContext(ctx, idsite) {
  const memoKey = `bot:${idsite}`;
  if (ctx.batchNotes.has(memoKey)) return ctx.batchNotes.get(memoKey);

  const build = (async () => {
    const { kept, longTailSessions } = await fetchFingerprintAggregates(ctx, idsite);
    const { counts, siteWeek } = await fetchVersionShares(ctx, idsite);

    const candidates = [];
    for (const fp of kept.values()) {
      if (baseConditions(fp.sessions, fp.orders, fp.atc, fp.product, fp.single)) {
        candidates.push(fp);
      }
    }
    /** @type {Map<string, {tier: string, reasons: string[]}>} */
    const tiers = new Map();
    const tierCounts = { confirmed: 0, suspect: 0 };
    for (const fp of candidates) {
      const share = thisVersionShare(counts, siteWeek, fp.week, fp.version);
      const prior = priorVersionShare(counts, siteWeek, fp.week, fp.version);
      const reasons = fingerprintReasons(
        isSquareResolution(fp.resolution),
        isDatacenterCity(fp.city),
        0,
        versionSpike(share, prior.share, prior.sessions),
      );
      const { tier } = fingerprintTier(true, reasons);
      if (tier) {
        tiers.set(`${fp.week}|${fp.fpHash}`, { tier, reasons });
        tierCounts[tier] += 1;
      }
    }

    const context = {
      /** @param {string} week Monday YYYY-MM-DD @param {string|bigint} fpHash */
      tierOf(week, fpHash) {
        return tiers.get(`${week}|${fpHash}`) ?? null;
      },
      notes: {
        bot_fingerprints: kept.size,
        bot_candidates: candidates.length,
        bot_long_tail_sessions: longTailSessions,
        bot_tiers: tierCounts,
        bot_fleet_scan: 'not_run',
      },
    };
    ctx.logger.info({ idsite, ...context.notes }, 'bot classification ready');
    return context;
  })();

  ctx.batchNotes.set(memoKey, build);
  return build;
}

export { applySafety };
