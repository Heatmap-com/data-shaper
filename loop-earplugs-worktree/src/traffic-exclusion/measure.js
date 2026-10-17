import { ORDERS_CTE } from '../adapters/_lib/sql.js';

/**
 * Session totals for one site and window. Dead sessions are one page,
 * zero clicks, zero scroll, and no transaction. A purchase with no
 * click and no scroll is a consent refusal, and it stays in the count.
 * Patterns are resolution by device.
 * @param {import('../ports/dataset.js').QueryGateway} gateway
 * @param {{idsite: number, windowStart: string, windowEnd: string}} key
 */
export async function measureTraffic(gateway, key) {
  const sql = `
WITH
visits AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit,
           toUInt8(argMin(config_device_type, visit_first_action_time)) AS device,
           trim(toString(argMin(config_resolution, visit_first_action_time))) AS resolution
    FROM default.udp_hsrce_visits
    WHERE idsite = {idsite:UInt32}
      AND server_date BETWEEN {w0:Date} AND {w1:Date}
    GROUP BY idvisit
),
parsed AS (
    SELECT idvisit, device, resolution,
           toUInt16OrZero(splitByChar('x', replaceAll(lower(replaceAll(resolution, '×', 'x')), ' ', ''))[1]) AS width,
           toUInt16OrZero(splitByChar('x', replaceAll(lower(replaceAll(resolution, '×', 'x')), ' ', ''))[2]) AS height
    FROM visits
),
pages AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit,
           count() AS pageviews,
           max(ifNull(scroll_y_max_relative, 0)) AS scroll_max
    FROM default.udp_hsrce_pageviews
    WHERE idsite = {idsite:UInt32}
      AND server_date BETWEEN {w0:Date} AND {w1:Date}
    GROUP BY idvisit
),
clicks AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit, count() AS clicks
    FROM default.udp_clicksce_clicks
    WHERE idsite = {idsite:UInt32}
      AND server_date BETWEEN {w0:Date} AND {w1:Date}
    GROUP BY idvisit
),
${ORDERS_CTE}
SELECT p.resolution AS resolution,
       p.device AS device,
       p.width AS width,
       p.height AS height,
       count() AS sessions,
       sum(ifNull(o.orders_udp, 0)) AS orders,
       sum(ifNull(c.clicks, 0)) AS clicks,
       sum(ifNull(o.revenue_udp, 0)) AS revenue,
       countIf(ifNull(pg.pageviews, 0) <= 1 AND ifNull(c.clicks, 0) = 0 AND ifNull(pg.scroll_max, 0) = 0 AND ifNull(o.orders_udp, 0) = 0) AS dead_sessions,
       countIf(ifNull(pg.pageviews, 0) <= 1 AND ifNull(c.clicks, 0) = 0 AND ifNull(pg.scroll_max, 0) = 0 AND ifNull(o.orders_udp, 0) > 0) AS retained_sessions,
       sumIf(ifNull(o.orders_udp, 0), ifNull(pg.pageviews, 0) <= 1 AND ifNull(c.clicks, 0) = 0 AND ifNull(pg.scroll_max, 0) = 0 AND ifNull(o.orders_udp, 0) > 0) AS retained_orders,
       sumIf(ifNull(o.revenue_udp, 0), ifNull(pg.pageviews, 0) <= 1 AND ifNull(c.clicks, 0) = 0 AND ifNull(pg.scroll_max, 0) = 0 AND ifNull(o.orders_udp, 0) > 0) AS retained_revenue
FROM parsed p
LEFT JOIN pages pg ON pg.idvisit = p.idvisit
LEFT JOIN clicks c ON c.idvisit = p.idvisit
LEFT JOIN orders o ON o.idvisit = p.idvisit
GROUP BY resolution, device, width, height
`;
  const rows = await gateway.query(
    sql,
    { idsite: key.idsite, w0: key.windowStart, w1: key.windowEnd },
    'traffic-exclusion:patterns',
  );
  let siteSessions = 0;
  const dead = { sessions: 0, orders: 0, clicks: 0, revenue: 0 };
  const retained = { sessions: 0, orders: 0, clicks: 0, revenue: 0 };
  const patterns = [];
  for (const row of rows) {
    const sessions = Number(row.sessions) || 0;
    siteSessions += sessions;
    dead.sessions += Number(row.dead_sessions) || 0;
    retained.sessions += Number(row.retained_sessions) || 0;
    retained.orders += Number(row.retained_orders) || 0;
    retained.revenue += Number(row.retained_revenue) || 0;
    patterns.push({
      resolution: String(row.resolution ?? ''),
      device: Number(row.device) || 0,
      width: Number(row.width) || 0,
      height: Number(row.height) || 0,
      sessions,
      orders: Number(row.orders) || 0,
      clicks: Number(row.clicks) || 0,
      revenue: Number(row.revenue) || 0,
    });
  }
  return { siteSessions, dead, retained, patterns };
}
