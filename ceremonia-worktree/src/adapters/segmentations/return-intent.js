/**
 * Return intent: what the same visitor (config_id, the identity the trigger
 * chains use) did on earlier visits within the lookback. It reads history
 * before the window, so it is computed in SQL and has no JavaScript twin.
 * A visit with a blank config_id has no history and falls to
 * `returning_unseen` or `new`.
 */

import { TIME_ON_PAGE_CAP_MS } from '../_lib/sql.js';
import { addDays } from '../../triggers/time.js';

export const RETURN_INTENT_VALUES = Object.freeze([
  'new',
  'returning_unseen',
  'prior_buyer',
  'open_cart',
  'prior_high_intent',
  'prior_browse',
]);

/**
 * One state per visit from {p0} through {w1}: buyer (an order or a
 * completed checkout), cart (add to cart or checkout start, no purchase),
 * high_intent (the showed-interest predicate), or browse. `prior` reads the
 * visitor's previous visit and the latest cart and purchase before this one.
 */
export function historyCtes() {
  return `
history AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit,
           ifNull(toString(argMin(config_id, visit_first_action_time)), '') AS visitor,
           parseDateTimeBestEffortOrZero(ifNull(min(visit_first_action_time), '')) AS started_at
    FROM default.udp_hsrce_visits
    WHERE idsite = {idsite:UInt32}
      AND server_date BETWEEN {p0:Date} AND {w1:Date}
    GROUP BY idvisit
),
history_pages AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit,
           uniqExact(idsitehsr) AS pages,
           max(ifNull(scroll_y_max_relative, 0)) AS scroll_max,
           sum(least(toUInt64(ifNull(time_on_page, 0)), ${TIME_ON_PAGE_CAP_MS})) AS capped_ms
    FROM default.udp_hsrce_pageviews
    WHERE idsite = {idsite:UInt32}
      AND server_date BETWEEN {p0:Date} AND {w1:Date}
    GROUP BY idvisit
),
history_clicks AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit, count() AS clicks
    FROM default.udp_clicksce_clicks
    WHERE idsite = {idsite:UInt32}
      AND server_date BETWEEN {p0:Date} AND {w1:Date}
    GROUP BY idvisit
),
history_events AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit,
           max(event_type IN ('add_to_cart', 'checkout_started')) AS carted,
           max(event_type = 'checkout_completed') AS completed
    FROM default.journey_events_map
    WHERE idsite = {idsite:UInt32}
      AND server_date BETWEEN {p0:Date} AND {w1:Date}
      AND event_type IN ('add_to_cart', 'checkout_started', 'checkout_completed')
    GROUP BY idvisit
),
history_orders AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit
    FROM default.udp_conversions
    WHERE idsite = {idsite:UInt32}
      AND server_date BETWEEN {p0:Date} AND {w1:Date}
    GROUP BY idvisit
),
history_state AS (
    SELECT h.idvisit AS idvisit,
           h.visitor AS visitor,
           h.started_at AS started_at,
           multiIf(
             ho.idvisit = h.idvisit OR he.completed = 1, 'buyer',
             he.carted = 1, 'cart',
             hp.pages > {minPages:UInt32}
               OR (hc.clicks > {minClicks:UInt32}
                   AND hp.scroll_max > {minScroll:UInt32}
                   AND hp.capped_ms > {minDurationMs:UInt64}), 'high_intent',
             'browse') AS state
    FROM history AS h
    LEFT JOIN history_pages AS hp ON hp.idvisit = h.idvisit
    LEFT JOIN history_clicks AS hc ON hc.idvisit = h.idvisit
    LEFT JOIN history_events AS he ON he.idvisit = h.idvisit
    LEFT JOIN history_orders AS ho ON ho.idvisit = h.idvisit
    WHERE h.visitor != ''
),
prior AS (
    SELECT idvisit,
           started_at,
           lagInFrame(state, 1, '') OVER w_all AS prev_state,
           lagInFrame(started_at, 1, started_at) OVER w_all AS prev_started,
           max(if(state = 'cart', started_at, toDateTime(0))) OVER w_before AS last_cart,
           max(if(state = 'buyer', started_at, toDateTime(0))) OVER w_before AS last_buy
    FROM history_state
    WINDOW w_all AS (PARTITION BY visitor ORDER BY started_at, idvisit ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING),
           w_before AS (PARTITION BY visitor ORDER BY started_at, idvisit ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
)`;
}

/**
 * The previous visit is read only when it is inside the lookback. An open
 * cart is a cart later than the last purchase, inside the lookback, on any
 * earlier visit. A previous purchase outranks an open cart, and an open cart
 * outranks the previous visit's intent.
 * @param {Readonly<Record<string, string>>} columns the grain's column map; reads `returning`
 */
export function returnIntentSql(columns) {
  if (!columns?.returning) throw new Error('segmentation return_intent: field "returning" has no column in this query');
  return `multiIf(
    p.prev_state = 'buyer' AND dateDiff('day', p.prev_started, p.started_at) <= {lookback:UInt32}, 'prior_buyer',
    p.last_cart > toDateTime(0) AND p.last_cart > p.last_buy AND dateDiff('day', p.last_cart, p.started_at) <= {lookback:UInt32}, 'open_cart',
    p.prev_state = 'high_intent' AND dateDiff('day', p.prev_started, p.started_at) <= {lookback:UInt32}, 'prior_high_intent',
    p.prev_state != '' AND dateDiff('day', p.prev_started, p.started_at) <= {lookback:UInt32}, 'prior_browse',
    ${columns.returning} = 1, 'returning_unseen',
    'new')`;
}

/**
 * The showed-interest predicate's thresholds as the history query binds them.
 * @param {{min_pages: unknown, min_clicks: unknown, min_scroll_pct: unknown, min_duration_sec: unknown}} interest
 */
function thresholds(interest) {
  return {
    minPages: Number(interest.min_pages),
    minClicks: Number(interest.min_clicks),
    minScroll: Math.round(Number(interest.min_scroll_pct) * 10),
    minDurationMs: Math.round(Number(interest.min_duration_sec) * 1000),
  };
}

/** @type {import('../../ports/segmentation.js').SegmentationAdapter} */
export const adapter = {
  id: 'return_intent',
  label: 'Return intent',
  values: RETURN_INTENT_VALUES,
  grains: ['trend', 'tagTrend'],
  needs: [],
  inputs: ['lookbackDays', 'interest'],
  codeVersion: 1,
  sql: returnIntentSql,
  ctes: () => historyCtes(),
  joins: () => 'LEFT JOIN prior AS p ON p.idvisit = k.idvisit',
  params: ({ start, lookbackDays, interest }) => ({
    p0: addDays(start, -lookbackDays),
    lookback: lookbackDays,
    ...thresholds(interest),
  }),
  stampInputs: ({ lookbackDays, interest }) => ({ lookbackDays, ...thresholds(interest) }),
};
