// One-off live probe: connectivity, DDL creation, and the Phase-0 column
// facts the dataset adapters hard-code. Run: node scripts/probe-clickhouse.mjs
import { ensureSchema } from '../src/adapters/persistence/clickhouse/schema-migrator.js';
import { clickHouseConfig, createClickHouseClient } from '../src/composition/clickhouse.js';

const { database } = clickHouseConfig(process.env);
const client = createClickHouseClient(clickHouseConfig(process.env));
const q = async (sql, params = {}) => (await client.query({ query: sql, query_params: params, format: 'JSONEachRow' })).json();

await ensureSchema(client, database);
console.log('schema ensured, database:', database);
const tables = await q(`SELECT name FROM system.tables WHERE database = {d:String} ORDER BY name`, { d: database });
console.log('analysis tables:', tables.map((t) => t.name).join(', '));

const cols = async (table) =>
  (await q(`SELECT name, type FROM system.columns WHERE database = 'default' AND table = {t:String} ORDER BY name`, { t: table }))
    .map((c) => `${c.name} ${c.type}`);

for (const t of ['udp_hsrce_visits', 'udp_hsrce_pageviews', 'udp_clicksce_clicks', 'udp_conversions', 'udp_am_elements', 'udp_conversion_product_items', 'conversion_item', 'udp_session_tags', 'udp_custom_events', 'sites', 'site_hsr', 'journey_events_map']) {
  const list = await cols(t);
  console.log(`\n== ${t} (${list.length} columns)`);
  console.log(list.join('\n'));
}

// time_since_load unit sample + scroll scale + visitor_returning sample on 3199
const tsl = await q(`
  SELECT anyHeavy(time_since_load) AS sample_vals, count() AS n
  FROM (SELECT time_since_load FROM default.udp_clicksce_clicks
        WHERE idsite = 3199 AND server_date >= toDate('2026-09-26') AND server_date <= toDate('2026-10-02') AND time_since_load > 0 LIMIT 100000)
`);
console.log('\ntime_since_load sample:', JSON.stringify(tsl));

const scroll = await q(`
  SELECT max(scroll_y_max_relative) AS mx, quantile(0.5)(scroll_y_max_relative) AS p50
  FROM default.udp_hsrce_pageviews
  WHERE idsite = 3199 AND idsitehsr = 63918696 AND server_date >= toDate('2026-09-26') AND server_date <= toDate('2026-10-02')
`);
console.log('scroll scale check (0-1000 expected):', JSON.stringify(scroll));

const ret = await q(`
  SELECT visitor_returning, count() AS n FROM default.udp_hsrce_visits
  WHERE idsite = 3199 AND server_date >= toDate('2026-09-26') AND server_date <= toDate('2026-10-02')
  GROUP BY visitor_returning ORDER BY n DESC LIMIT 5
`);
console.log('visitor_returning values:', JSON.stringify(ret));

const k5 = await q(`
  SELECT custom_var_k5, count() AS n FROM default.udp_hsrce_visits
  WHERE idsite = 3199 AND server_date >= toDate('2026-09-26') AND server_date <= toDate('2026-10-02') AND custom_var_k5 != ''
  GROUP BY custom_var_k5 ORDER BY n DESC LIMIT 3
`);
console.log('custom_var_k5 sample:', JSON.stringify(k5).slice(0, 400));

process.exit(0);
