/**
 * The rows a data-quality screen reads. A groups subject is a shaped
 * query keyed by one attribute (shapeSql); an orders subject is this one:
 * every order of a kept session in the window, one row per order, deduped
 * as the session query dedupes them. Every fact alias carries idsite and
 * server_date, so the gateway's `shape:` bound check passes.
 */

import { periodSql } from '../domain/shaping/period.js';
import { SHAPE_SETTINGS } from './shape-sql.js';
import { sessionCtes } from './trend-sql.js';

/** @param {import('../domain/shaping/period.js').PeriodSpec} period the window grain */
export function qualityOrdersSql(period) {
  const periodOf = (dateExpr) => periodSql(dateExpr, period);
  return `
WITH
${sessionCtes({ period: periodOf })},
order_rows AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit,
           toString(idorder) AS idorder,
           ${periodOf('min(server_date)')} AS week,
           any(revenue) AS revenue
    FROM default.udp_conversions
    WHERE idsite = {idsite:UInt32}
      AND server_date BETWEEN {w0:Date} AND {w1:Date}
    GROUP BY idvisit, idorder
)
SELECT o.idorder AS idorder, toString(o.idvisit) AS idvisit, o.revenue AS revenue
FROM order_rows AS o
INNER JOIN kept AS k ON k.idvisit = o.idvisit AND k.week = o.week
ORDER BY idorder
${SHAPE_SETTINGS}`;
}
