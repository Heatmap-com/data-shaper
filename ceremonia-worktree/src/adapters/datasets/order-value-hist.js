/**
 * order-value-hist: per-order revenue for deduplicated orders on the page's
 * entry sessions, bucketed in $10 steps from $0 through $200 plus an open
 * 200+ bucket, with a second row kind carrying exact p25/p50/p75. Sessions
 * with an order are rescued from the confirmed bot tier by the safety rule,
 * so both bot filters carry identical numbers. Rule 14.
 */

import { quantile } from '../_lib/checks.js';

const BUCKET_LABELS = [...Array.from({ length: 20 }, (_, i) => `${i * 10}-${i * 10 + 10}`), '200+'];

export const adapter = {
  id: 'order-value-hist',
  dependsOn: [],
  scope: 'page',
  provides: ['H14'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const sql = `
WITH
entry AS (
    SELECT idvisit
    FROM (
        SELECT idvisit, toString(argMin(visit_entry_idaction_url, visit_first_action_time)) AS entry_hsr
        FROM default.udp_hsrce_visits
        WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
        GROUP BY idvisit
    )
    WHERE entry_hsr = {hsr:String}
),
orders AS (
    SELECT idvisit, idorder, any(revenue) AS revenue
    FROM default.udp_conversions FINAL
    WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
    GROUP BY idvisit, idorder
)
SELECT o.idorder AS idorder, ifNull(o.revenue, 0) AS revenue
FROM orders o
INNER JOIN entry e ON e.idvisit = o.idvisit
`;
    const raw = await ctx.gateway.query(
      sql,
      { idsite: page.idsite, hsr: String(page.idsitehsr), w0: ctx.windowStart, w1: ctx.windowEnd },
      'order-value-hist:orders',
    );
    const revenues = raw.map((r) => Number(r.revenue));

    /** @type {Array<{orders: number, revenue: number}>} */
    const buckets = BUCKET_LABELS.map(() => ({ orders: 0, revenue: 0 }));
    for (const rev of revenues) {
      const idx = rev >= 200 ? buckets.length - 1 : Math.max(0, Math.floor(rev / 10));
      buckets[idx].orders += 1;
      buckets[idx].revenue += rev;
    }

    const sorted = [...revenues].sort((a, b) => a - b);
    /** @param {number} q */
    const pct = (q) => {
      const v = quantile(sorted, q);
      return v == null ? null : round2(v);
    };

    const rows = [];
    for (const filter of ['none', 'exclude_confirmed']) {
      buckets.forEach((b, i) => {
        rows.push({
          dims: { bot_filter: filter, bucket: BUCKET_LABELS[i] },
          metrics: { orders: b.orders, revenue: round2(b.revenue) },
        });
      });
      rows.push({
        dims: { bot_filter: filter, kind: 'percentiles' },
        metrics: { p25: pct(0.25), p50: pct(0.5), p75: pct(0.75) },
      });
    }

    return {
      id: adapter.id,
      rows,
      notes: {
        order_value_hist_note: 'sessions with orders are rescued from the confirmed bot tier by the safety rule; both bot_filter rows carry identical numbers',
      },
    };
  },
};

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}
