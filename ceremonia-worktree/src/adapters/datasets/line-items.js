import { ENTRY_VISITS_CTE } from '../_lib/sql.js';

/**
 * line-items: order lines for deduplicated orders on the page's entry
 * sessions. udp_conversion_product_items is tried first (joined per
 * (idsite, idvisit), no idorder in that table); a site with no rows there
 * falls back to conversion_item, whose sku is String(idaction_sku).
 */

export const adapter = {
  id: 'line-items',
  dependsOn: [],
  scope: 'page',
  provides: ['H13'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const params = { idsite: page.idsite, hsr: String(page.idsitehsr), w0: ctx.windowStart, w1: ctx.windowEnd };
    const ordersSql = `
WITH
${ENTRY_VISITS_CTE},
orders AS (
    SELECT idvisit, idorder, any(revenue) AS revenue
    FROM default.udp_conversions FINAL
    WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
    GROUP BY idvisit, idorder
)
SELECT toString(o.idvisit) AS idvisit, o.idorder AS idorder, ifNull(o.revenue, 0) AS revenue
FROM orders o
INNER JOIN entry e ON e.idvisit = CAST(o.idvisit AS UInt64)
`;
    const orderRows = await ctx.gateway.query(ordersSql, params, 'line-items:orders');
    /** @type {Map<string, string[]>} idvisit -> idorders */
    const ordersByVisit = new Map();
    for (const r of orderRows) {
      const list = ordersByVisit.get(r.idvisit) ?? [];
      list.push(r.idorder);
      ordersByVisit.set(r.idvisit, list);
    }

    const itemsSql = `
WITH
${ENTRY_VISITS_CTE}
SELECT toString(i.idvisit) AS idvisit, i.sku AS sku, any(i.title) AS product_name,
       sum(ifNull(i.quantity, 0)) AS quantity,
       round(sum(ifNull(i.quantity, 0) * ifNull(i.price, 0)), 2) AS line_revenue
FROM default.udp_conversion_product_items i
INNER JOIN entry e ON e.idvisit = CAST(i.idvisit AS UInt64)
WHERE i.idsite = {idsite:UInt32}
GROUP BY i.idvisit, i.sku
`;
    let items = await ctx.gateway.query(itemsSql, params, 'line-items:product-items');
    let itemSource = 'udp_conversion_product_items';

    let orderAttributionNote = '';
    if (items.length === 0) {
      const columns = await ctx.gateway.columns('conversion_item');
      const hasIdsite = columns.some((c) => c.name === 'idsite');
      const fallbackSql = `
WITH
${ENTRY_VISITS_CTE}
SELECT toString(i.idvisit) AS idvisit, i.idorder AS idorder, toString(i.idaction_sku) AS sku,
       any(i.title) AS product_name, sum(i.quantity) AS quantity,
       round(sum(i.quantity * i.price), 2) AS line_revenue
FROM default.conversion_item i
INNER JOIN entry e ON e.idvisit = CAST(i.idvisit AS UInt64)
${hasIdsite ? 'WHERE i.idsite = {idsite:UInt32}' : ''}
GROUP BY i.idvisit, i.idorder, i.idaction_sku
`;
      items = await ctx.gateway.query(fallbackSql, params, 'line-items:conversion-item');
      itemSource = 'conversion_item';
      if (!hasIdsite) {
        orderAttributionNote = 'conversion_item has no idsite column; items joined on idvisit only';
      }
    } else {
      orderAttributionNote =
        'udp_conversion_product_items has no idorder; single-order visits attributed to their order, multi-order visits left blank';
    }

    const rows = items.map((r) => {
      const visitOrders = ordersByVisit.get(r.idvisit) ?? [];
      const order = itemSource === 'conversion_item' ? r.idorder : visitOrders.length === 1 ? visitOrders[0] : '';
      return {
        dims: {
          order,
          sku: String(r.sku ?? ''),
          item_source: itemSource,
          idvisit: r.idvisit,
          product_name: String(r.product_name ?? ''),
        },
        metrics: {
          quantity: Number(r.quantity),
          line_revenue: Number(r.line_revenue),
        },
      };
    });

    return {
      id: adapter.id,
      rows,
      notes: {
        line_item_source: itemSource,
        line_item_rows: rows.length,
        line_item_note: orderAttributionNote,
      },
    };
  },
};
