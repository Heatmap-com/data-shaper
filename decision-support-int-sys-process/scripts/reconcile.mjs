// Live reconciliation (IMPLEMENTATION-PLAN.md section 11): for each analysis
// row of a batch, sessions_unfiltered and orders_unfiltered must match a
// fresh bot_filter=none query within 0.5% or 5 sessions, whichever is larger.
// Usage: node scripts/reconcile.mjs <batch_id>
import { clickHouseConfig, createClickHouseClient } from '../src/composition/clickhouse.js';

const [batchId] = process.argv.slice(2);
if (!batchId) {
  console.error('usage: node scripts/reconcile.mjs <batch_id>');
  process.exit(2);
}

const config = clickHouseConfig(process.env);
const client = createClickHouseClient(config);
const q = async (sql, params = {}) =>
  (await client.query({ query: sql, query_params: params, format: 'JSONEachRow' })).json();

const rows = await q(
  `SELECT idsite, idsitehsr, url, window_start, window_end,
          sessions_unfiltered, orders_unfiltered
     FROM ${config.database}.ae_page_analysis_current
    WHERE batch_id = {batchId:UUID}`,
  { batchId: batchId },
);

if (rows.length === 0) {
  console.error(`no analysis rows for batch ${batchId}`);
  process.exit(2);
}

/** @param {number} stored @param {number} fresh */
function within(stored, fresh) {
  const tolerance = Math.max(5, fresh * 0.005);
  return Math.abs(stored - fresh) <= tolerance;
}

let misses = 0;
for (const r of rows) {
  const fresh = await q(
    `
WITH entry AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit
    FROM (
        SELECT idvisit, toString(argMin(visit_entry_idaction_url, visit_first_action_time)) AS entry_hsr
        FROM default.udp_hsrce_visits
        WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
        GROUP BY idvisit
    )
    WHERE entry_hsr = {hsr:String}
),
orders AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit, uniqExact(idorder) AS orders_udp
    FROM (
        SELECT idvisit, idorder
        FROM default.udp_conversions FINAL
        WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
        GROUP BY idvisit, idorder
    )
    GROUP BY idvisit
)
SELECT count() AS sessions, sum(ifNull(o.orders_udp, 0)) AS orders
FROM entry e
LEFT JOIN orders o ON o.idvisit = e.idvisit
`,
    { idsite: Number(r.idsite), hsr: String(r.idsitehsr), w0: r.window_start, w1: r.window_end },
  );
  const datasetRows = await q(
    `SELECT count() AS n FROM ${config.database}.ae_dataset_row_current
      WHERE batch_id = {batchId:UUID} AND idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}`,
    { batchId, idsite: Number(r.idsite), idsitehsr: Number(r.idsitehsr) },
  );
  const f = fresh[0];
  const sessionsOk = within(Number(r.sessions_unfiltered), Number(f.sessions));
  const ordersOk = within(Number(r.orders_unfiltered), Number(f.orders));
  const status = sessionsOk && ordersOk ? 'OK  ' : 'MISS';
  if (!(sessionsOk && ordersOk)) misses += 1;
  console.log(
    `${status} ${r.idsite} ${r.idsitehsr} ${r.url}\n` +
      `     stored   sessions=${r.sessions_unfiltered} orders=${r.orders_unfiltered} dataset_rows=${datasetRows[0].n}\n` +
      `     fresh    sessions=${f.sessions} orders=${f.orders}`,
  );
}

console.log(misses === 0 ? 'reconciliation passed' : `${misses} miss(es)`);
process.exit(misses === 0 ? 0 : 1);
