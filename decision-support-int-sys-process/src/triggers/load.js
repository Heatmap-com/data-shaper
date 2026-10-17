import { TIME_ON_PAGE_CAP_MS, sessionUtmSql, tagUtmCte } from '../adapters/_lib/sql.js';
import { fetchHsrPages } from '../adapters/_lib/urls.js';
import { DEFAULT_TRIGGERS, resolveDefinitions } from './definitions.js';
import { addDays } from './time.js';

/**
 * How far back a run has to read. The chain window and the visitor window
 * sit in front of windowStart so a hit that is still open can be recomputed.
 * Prior purchase looks back further, and only purchase sessions are read
 * from that older span. A 365-day lookback reads a year of purchase visits
 * for every site; that cost is the prior-purchaser clause.
 *
 * @param {string} windowStart
 * @param {string} windowEnd
 * @param {object[]} definitions
 */
export function factWindow(windowStart, windowEnd, definitions) {
  const chain = Math.max(0, ...definitions.map((row) => Number(row.predicate.chain_window_days) || 0));
  const visitor = Math.max(0, ...definitions.map((row) => Number(row.predicate.window_days) || 0));
  const lookback = Math.max(0, ...definitions.map((row) => Number(row.predicate.prior_purchase_lookback_days) || 0));
  const factStart = addDays(windowStart, -(chain + visitor));
  return {
    factStart,
    factEnd: windowEnd,
    purchaseStart: addDays(factStart, -lookback),
    purchaseEnd: addDays(factStart, -1),
    lookbackDays: lookback,
  };
}

/**
 * What the day scan's trigger lane reads. Hits feed the batch from
 * `firstHitDay` (the window start, or earlier when a chain open on the last
 * day began before it). A visitor hit on day h reads sessions back to
 * h - window_days, and a chain reads only sessions after its hit, so the lane
 * starts window_days before the first hit day, plus one day so a visit that
 * crosses into the first needed day is dated before it, as the window query
 * dates it. Purchase sessions before the lane come from the prior-purchase
 * read, from the same purchaseStart as factWindow.
 *
 * @param {string} windowStart
 * @param {string} windowEnd
 * @param {object[]} definitions
 */
export function scanWindow(windowStart, windowEnd, definitions) {
  const facts = factWindow(windowStart, windowEnd, definitions);
  const chain = Math.max(0, ...definitions.map((row) => Number(row.predicate.chain_window_days) || 0));
  const visitor = Math.max(0, ...definitions.map((row) => Number(row.predicate.window_days) || 0));
  const firstHitDay = [windowStart, addDays(windowEnd, -chain)].sort()[0];
  const laneStart = addDays(firstHitDay, -(visitor + 1));
  return {
    laneStart,
    firstHitDay,
    retainDays: Math.max(chain, visitor),
    purchaseStart: facts.purchaseStart,
    purchaseEnd: addDays(laneStart, -1),
    lookbackDays: facts.lookbackDays,
  };
}

/** Event names the active predicates name. The SQL filter is this list. */
export function eventNames(definitions) {
  const names = new Set();
  for (const row of definitions) {
    for (const key of ['intent_events', 'purchase_events']) {
      for (const name of row.predicate[key] ?? []) names.add(name);
    }
    if (row.predicate.atc_event) names.add(row.predicate.atc_event);
  }
  return [...names];
}

/**
 * @param {import('../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @param {object[]} recorded
 */
export async function loadTriggerFacts(ctx, idsite, recorded) {
  const definitions = resolveDefinitions(overridesFrom(recorded), recorded);
  const bounds = factWindow(ctx.windowStart, ctx.windowEnd, definitions);
  const names = eventNames(definitions);
  const params = { idsite, w0: bounds.factStart, w1: bounds.factEnd, events: names };
  const [visits, pageviews, clicks, events, orders, tags, urls] = await Promise.all([
    ctx.gateway.query(visitsSql(), params, 'trigger-chains:visits'),
    ctx.gateway.query(PAGES_SQL, params, 'trigger-chains:pages'),
    ctx.gateway.query(CLICKS_SQL, params, 'trigger-chains:clicks'),
    names.length === 0
      ? Promise.resolve([])
      : ctx.gateway.query(EVENTS_SQL, params, 'trigger-chains:events'),
    ctx.gateway.query(ORDERS_SQL, params, 'trigger-chains:orders'),
    ctx.gateway.query(TAGS_SQL, params, 'trigger-chains:tags'),
    fetchHsrPages(ctx, idsite),
  ]);
  const prior = bounds.purchaseEnd >= bounds.purchaseStart
    ? await loadPriorPurchases(ctx, idsite, bounds, names, purchaseRule(definitions))
    : { visits: [], events: [], orders: [] };
  return { definitions, bounds, visits, pageviews, clicks, events, orders, tags, urls, prior };
}

/** @param {object[]} definitions */
export function purchaseRule(definitions) {
  return {
    events: new Set(definitions.flatMap((row) => row.predicate.purchase_events ?? [])),
    ordersCount: definitions.some((row) => row.predicate.purchase_also_counts_order),
  };
}

/**
 * Purchase sessions before the fact window. They carry no page counts, so
 * they cannot qualify as showed-interest on their own.
 * @param {import('../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @param {{purchaseStart: string, purchaseEnd: string}} bounds
 * @param {string[]} names
 * @param {{events: Set<string>, ordersCount: boolean}} rule
 */
export async function loadPriorPurchases(ctx, idsite, bounds, names, rule) {
  const params = { idsite, w0: bounds.purchaseStart, w1: bounds.purchaseEnd, events: names, purchase: [...rule.events] };
  const purchased = priorPurchasePred(rule);
  const [visits, events, orders] = await Promise.all([
    ctx.gateway.query(visitsSql(purchased), params, 'trigger-chains:prior-visits'),
    names.length === 0 ? Promise.resolve([]) : ctx.gateway.query(eventsSql(purchased), params, 'trigger-chains:prior-events'),
    ctx.gateway.query(ordersSql(purchased), params, 'trigger-chains:prior-orders'),
  ]);
  const purchaseVisits = new Set();
  for (const row of events) {
    if (rule.events.has(String(row.event_type))) purchaseVisits.add(String(row.idvisit));
  }
  if (rule.ordersCount) {
    for (const row of orders) {
      if (Number(row.orders) > 0) purchaseVisits.add(String(row.idvisit));
    }
  }
  return {
    visits: visits.filter((row) => purchaseVisits.has(String(row.idvisit))),
    events: events.filter((row) => purchaseVisits.has(String(row.idvisit))),
    orders: orders.filter((row) => purchaseVisits.has(String(row.idvisit))),
  };
}

/** @param {object[]} recorded */
export function overridesFrom(recorded) {
  const known = new Set(DEFAULT_TRIGGERS.map((row) => row.key));
  /** @type {Record<string, object>} */
  const overrides = {};
  for (const row of recorded) {
    if (!row?.key || !row.predicate || !known.has(row.key)) continue;
    overrides[row.key] = { ...row.predicate, active: row.active };
  }
  return overrides;
}

/**
 * Visit rows for one site and date window. The date predicate stays on the
 * inner query, whose aggregate aliases do not reuse server_date: ClickHouse
 * rejects min(server_date) AS server_date when the same name is in WHERE.
 * The UTMs are the session tags, with the custom variables as the fallback
 * (tagUtmCte).
 * @param {string} [extra] additional AND predicate, already parenthesized
 */
function visitsSql(extra = '') {
  return `
WITH ${tagUtmCte('tu', { keys: [['idvisit', 'CAST(idvisit AS UInt64)']], and: extra ? ` ${extra}` : '' })}
SELECT
    toString(r.idvisit) AS idvisit,
    toString(r.visit_day) AS server_date,
    toString(r.started_at) AS started_at,
    ifNull(toString(r.config_id), '') AS config_id,
    r.device AS device,
    r.referer AS referer,
    r.returning AS returning,
    r.country AS country,
    r.entry_hsr AS entry_hsr,
    ${sessionUtmSql('utm_source', 'tu', 'r.utm_source')} AS utm_source,
    r.ref_name AS referer_name,
    ${sessionUtmSql('utm_medium', 'tu', 'r.utm_medium')} AS utm_medium,
    ${sessionUtmSql('utm_campaign', 'tu', 'r.utm_campaign')} AS utm_campaign
FROM (
    SELECT
        idvisit,
        min(server_date) AS visit_day,
        argMin(visit_first_action_time, visit_first_action_time) AS started_at,
        argMin(config_id, visit_first_action_time) AS config_id,
        toUInt8(argMin(config_device_type, visit_first_action_time)) AS device,
        toInt32(argMin(referer_type, visit_first_action_time)) AS referer,
        toUInt8(ifNull(argMin(visitor_returning, visit_first_action_time), false)) AS returning,
        trim(toString(argMin(location_country, visit_first_action_time))) AS country,
        toString(argMin(visit_entry_idaction_url, visit_first_action_time)) AS entry_hsr,
        lower(trim(toString(argMin(custom_var_k5, visit_first_action_time)))) AS utm_source,
        trim(toString(argMin(referer_name, visit_first_action_time))) AS ref_name,
        ifNull(lower(trim(toString(argMin(custom_var_v1, visit_first_action_time)))), '') AS utm_medium,
        ifNull(trim(toString(argMin(custom_var_v4, visit_first_action_time))), '') AS utm_campaign
    FROM default.udp_hsrce_visits
    WHERE idsite = {idsite:UInt32}
      AND server_date BETWEEN {w0:Date} AND {w1:Date}
      ${extra}
    GROUP BY idvisit
) AS r
LEFT JOIN tu ON tu.idvisit = CAST(r.idvisit AS UInt64)
`;
}

/**
 * Prior-window rows are purchase sessions only. The lookback is up to a
 * year, so the visits, events, and orders are each constrained to the
 * visits that purchased in that span instead of every session.
 * @param {{events: Set<string>, ordersCount: boolean}} rule
 */
function priorPurchasePred(rule) {
  const parts = [];
  if (rule.events.size > 0) {
    parts.push(`idvisit IN (
        SELECT idvisit FROM default.journey_events_map
        WHERE idsite = {idsite:UInt32}
          AND server_date BETWEEN {w0:Date} AND {w1:Date}
          AND event_type IN {purchase:Array(String)}
    )`);
  }
  if (rule.ordersCount) {
    parts.push(`idvisit IN (
        SELECT idvisit FROM default.udp_conversions
        WHERE idsite = {idsite:UInt32}
          AND server_date BETWEEN {w0:Date} AND {w1:Date}
    )`);
  }
  return parts.length > 0 ? `AND (${parts.join(' OR ')})` : 'AND 0';
}

const TAGS_SQL = `
SELECT toString(idvisit) AS idvisit, tag_json AS session_tags
FROM (
    SELECT idvisit, min(session_tags) AS tag_json
    FROM default.udp_session_tags
    WHERE idsite = {idsite:UInt32}
      AND server_date BETWEEN {w0:Date} AND {w1:Date}
      AND session_tags NOT IN ('{}', '')
    GROUP BY idvisit
)
`;

const PAGES_SQL = `
SELECT
    toString(idvisit) AS idvisit,
    toString(idsitehsr) AS hsr,
    max(ifNull(scroll_y_max_relative, 0)) AS scroll_max,
    sum(least(toUInt64(ifNull(time_on_page, 0)), ${TIME_ON_PAGE_CAP_MS})) AS capped_ms
FROM default.udp_hsrce_pageviews
WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
GROUP BY idvisit, idsitehsr
`;

const CLICKS_SQL = `
SELECT toString(idvisit) AS idvisit, count() AS clicks
FROM default.udp_clicksce_clicks
WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
GROUP BY idvisit
`;

/** @param {string} [extra] additional AND predicate, already parenthesized */
function eventsSql(extra = '') {
  return `
SELECT toString(CAST(idvisit AS UInt64)) AS idvisit, event_type
FROM default.journey_events_map
WHERE idsite = {idsite:UInt32}
  AND server_date BETWEEN {w0:Date} AND {w1:Date}
  AND event_type IN {events:Array(String)}
  ${extra}
GROUP BY idvisit, event_type
`;
}

/** @param {string} [extra] additional AND predicate, already parenthesized */
function ordersSql(extra = '') {
  return `
SELECT toString(CAST(idvisit AS UInt64)) AS idvisit,
       uniqExact(idorder) AS orders,
       sum(revenue) AS revenue
FROM (
    SELECT idvisit, idorder, max(revenue) AS revenue
    FROM default.udp_conversions FINAL
    WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
      ${extra}
    GROUP BY idvisit, idorder
)
GROUP BY idvisit
`;
}

const EVENTS_SQL = eventsSql();
const ORDERS_SQL = ordersSql();
