import { clickHouseConfig, clickHouseDatabase, createClickHouseClient } from '../src/composition/clickhouse.js';
import fs from 'node:fs';

const client = createClickHouseClient(clickHouseConfig(process.env));
const settings = { max_execution_time: 600 };
const out = (name, rows) => { fs.writeFileSync(`/tmp/pc/${name}.json`, JSON.stringify(rows)); console.log(name, rows.length); };
const run = async (query) => (await client.query({ query, format: 'JSONEachRow', clickhouse_settings: settings })).json();

const PAGES = `pages AS (
 SELECT idsitehsr, url, multiIf(url IN ('https://dvf.com','https://dvf.com/'),'home', url LIKE '%/collections/private-sale%','private_sale', url LIKE '%/collections/%sale%','sale_coll', url LIKE '%/products/%','product', url LIKE '%/collections/new%' OR url LIKE '%fall%' OR url LIKE '%zankov%','new_fall_coll', url LIKE '%/collections/%','other_coll', url LIKE '%/search%','search', url LIKE '%/cart%' OR url LIKE '%checkout%','cart', url LIKE '%size-guide%','size_guide', url LIKE '%/account%','account', url LIKE '%/pages/%','content', 'other') pc
 FROM (SELECT idsitehsr, JSONExtractString(arrayElement(JSONExtractArrayRaw(ifNull(any(match_page_rules),'[]')),1),'value') url FROM default.site_hsr WHERE idsite=5795 GROUP BY idsitehsr))`;

const VISITS = (from, to) => `v AS (
 SELECT idvisit, min(server_date) d, argMin(ifNull(config_id,''), visit_first_action_time) cid,
   lower(argMin(ifNull(referer_name,''), visit_first_action_time)) rn, lower(argMin(ifNull(custom_var_v1,''), visit_first_action_time)) med,
   argMin(ifNull(custom_var_v4,''), visit_first_action_time) camp, argMin(config_device_type, visit_first_action_time) dev
 FROM default.udp_hsrce_visits WHERE idsite=5795 AND server_date BETWEEN '${from}' AND '${to}' GROUP BY idvisit
 HAVING NOT (rn='facebook' AND med='' AND camp='' AND dev=1))`;

const jobs = {
  orders: `
WITH o AS (SELECT idorder, any(idvisit) idvisit, any(revenue) rev, min(server_time) t, any(server_date) d, any(device_type) odev
  FROM default.udp_conversions FINAL WHERE idsite=5795 AND server_date BETWEEN '2026-08-01' AND '2026-10-10' GROUP BY idorder),
it AS (SELECT idorder, any(title) title, any(price) price, sum(quantity) qty, count() items
  FROM default.conversion_item WHERE idsite=5795 AND server_time >= '2026-07-31' AND server_time < '2026-10-12' AND deleted=0 GROUP BY idorder)
SELECT lower(hex(cityHash64(o.idorder))) oid, toString(o.idvisit) idvisit, toString(o.d) d, toString(o.t) t, o.rev rev, o.odev odev,
  ifNull(it.title,'') title, ifNull(it.price,0) price, ifNull(it.qty,0) qty, ifNull(it.items,0) items
FROM o LEFT JOIN it USING idorder ORDER BY o.t`,

  history_extra: `
WITH ${PAGES},
v AS (SELECT idvisit, argMin(ifNull(config_id,''), visit_first_action_time) cid, min(ifNull(visit_first_action_time,'')) t0, min(server_date) d
  FROM default.udp_hsrce_visits WHERE idsite=5795 AND server_date BETWEEN '2026-08-12' AND '2026-08-25' GROUP BY idvisit),
pv AS (SELECT idvisit, count() pvs, sum(least(toUInt64(ifNull(time_on_page,0)), 600000))/1000 secs, max(ifNull(scroll_y_max_relative,0)) sc
  FROM default.udp_hsrce_pageviews WHERE idsite=5795 AND server_date BETWEEN '2026-08-12' AND '2026-08-25' GROUP BY idvisit),
ev AS (SELECT toInt64(idvisit) idvisit, countIf(event_type='add_to_cart') e_atc, countIf(event_type='checkout_started') e_co
  FROM default.journey_events_map WHERE idsite=5795 AND server_date BETWEEN '2026-08-12' AND '2026-08-25' GROUP BY idvisit),
cl AS (SELECT idvisit, count() clicks FROM default.udp_clicksce_clicks WHERE idsite=5795 AND server_date BETWEEN '2026-08-12' AND '2026-08-25' GROUP BY idvisit),
o AS (SELECT idvisit, uniqExact(idorder) n FROM default.udp_conversions FINAL WHERE idsite=5795 AND server_date BETWEEN '2026-08-12' AND '2026-08-25' GROUP BY idvisit)
SELECT toString(v.idvisit) idvisit, v.cid cid, v.t0 t0, toString(v.d) d, ifNull(pv.pvs,0) pvs, ifNull(pv.secs,0) secs, ifNull(pv.sc,0) sc,
  ifNull(ev.e_atc,0) e_atc, ifNull(ev.e_co,0) e_co, ifNull(cl.clicks,0) clicks, ifNull(o.n,0) n
FROM v LEFT JOIN pv ON pv.idvisit=v.idvisit LEFT JOIN ev ON ev.idvisit=v.idvisit LEFT JOIN cl ON cl.idvisit=v.idvisit LEFT JOIN o ON o.idvisit=v.idvisit
WHERE v.cid != ''`,

  visit_scroll_max: `
SELECT toString(idvisit) idvisit, max(ifNull(scroll_y_max_relative,0)) sc
FROM default.udp_hsrce_pageviews WHERE idsite=5795 AND server_date BETWEEN '2026-08-26' AND '2026-10-09' GROUP BY idvisit`,

  page_period: `
WITH ${PAGES}, ${VISITS('2026-09-01', '2026-10-09')},
o AS (SELECT idvisit, uniqExact(idorder) n, sum(r) rev FROM (SELECT idvisit, idorder, any(revenue) r FROM default.udp_conversions FINAL WHERE idsite=5795 AND server_date BETWEEN '2026-09-01' AND '2026-10-09' GROUP BY idvisit, idorder) GROUP BY idvisit),
pv AS (SELECT p.idvisit idvisit, url, pc, min(p.server_time) first_t FROM default.udp_hsrce_pageviews p LEFT JOIN pages USING idsitehsr
  WHERE p.idsite=5795 AND p.server_date BETWEEN '2026-09-01' AND '2026-10-09' GROUP BY p.idvisit, url, pc),
ent AS (SELECT p.idvisit idvisit, argMin(url, p.server_time) eurl FROM default.udp_hsrce_pageviews p LEFT JOIN pages USING idsitehsr
  WHERE p.idsite=5795 AND p.server_date BETWEEN '2026-09-01' AND '2026-10-09' GROUP BY p.idvisit)
SELECT url, pc, multiIf(v.d < '2026-09-10','pre', v.d <= '2026-09-23','full', v.d <= '2026-10-04','promo','post') period, v.dev dev,
  count() visits, countIf(ifNull(o.n,0)>0) buyer_visits, sum(ifNull(o.rev,0)) buyer_visit_revenue,
  countIf(ent.eurl = url) entries, countIf(ent.eurl = url AND ifNull(o.n,0)>0) entry_buyer_visits
FROM pv JOIN v ON v.idvisit = pv.idvisit LEFT JOIN o ON o.idvisit = pv.idvisit LEFT JOIN ent ON ent.idvisit = pv.idvisit
GROUP BY url, pc, period, dev HAVING visits >= 10 ORDER BY visits DESC`,

  hv_page_reach: `
WITH ${PAGES}, ${VISITS('2026-09-10', '2026-10-09')},
o AS (SELECT idvisit, idorder, any(revenue) r FROM default.udp_conversions FINAL WHERE idsite=5795 AND server_date BETWEEN '2026-09-10' AND '2026-10-09' GROUP BY idvisit, idorder),
hv AS (SELECT DISTINCT v.cid cid FROM o JOIN v ON toInt64(v.idvisit) = toInt64(o.idvisit) WHERE o.r >= 1000 AND v.cid != ''),
pv AS (SELECT DISTINCT v.cid cid, pages.url url, pages.pc pc FROM default.udp_hsrce_pageviews p LEFT JOIN pages USING idsitehsr JOIN v ON toInt64(v.idvisit) = toInt64(p.idvisit)
  WHERE p.idsite=5795 AND p.server_date BETWEEN '2026-09-10' AND '2026-10-09' AND v.cid != '')
SELECT url, pc, uniqExact(cid) visitors, uniqExactIf(cid, cid IN (SELECT cid FROM hv)) hv_visitors,
  (SELECT uniqExact(cid) FROM v WHERE cid != '') all_visitors_total, (SELECT count() FROM hv) hv_visitors_total
FROM pv GROUP BY url, pc HAVING visitors >= 100 OR hv_visitors >= 3 ORDER BY hv_visitors DESC, visitors DESC`,

  pipeline_datasets: `
SELECT dataset_id, scope, bot_filter, toString(dim_week) dim_week, dim_device, dim_source, dim_returning, dim_selector, dim_element_class, dim_surface, dim_tool, dim_extra, metrics
FROM ${clickHouseDatabase(process.env)}.ae_dataset_row_current
WHERE idsite=5795 AND (bot_filter IN ('', 'exclude_confirmed', 'portal_11_4')
  OR (bot_filter='none' AND dataset_id NOT IN (SELECT DISTINCT dataset_id FROM ${clickHouseDatabase(process.env)}.ae_dataset_row_current WHERE idsite=5795 AND bot_filter='exclude_confirmed')))`,
};

const only = process.argv.slice(2);
for (const [name, q] of Object.entries(jobs)) {
  if (only.length && !only.includes(name)) continue;
  const t = Date.now();
  try { out(name, await run(q)); } catch (e) { console.error(name, 'ERR', e.message.slice(0, 400)); }
  console.log(`  ${((Date.now() - t) / 1000).toFixed(1)}s`);
}
await client.close();
