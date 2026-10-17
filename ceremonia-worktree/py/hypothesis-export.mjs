/**
 * Warehouse extracts behind the DVF P0 hypothesis brief.
 * Usage: node py/hypothesis-export.mjs [job ...]
 * Writes /tmp/hyp/raw/<job>.json. py/hypothesis-build.py turns them into the CSV attachments.
 */
import { clickHouseConfig, createClickHouseClient } from '../src/composition/clickhouse.js';
import fs from 'node:fs';

const IDSITE = 5795;
const V0 = '2026-09-01';
const V1 = '2026-10-11';
const D0 = '2026-08-01';
const OUT = '/tmp/hyp/raw';
fs.mkdirSync(OUT, { recursive: true });

const client = createClickHouseClient(clickHouseConfig(process.env));
const run = async (query) =>
  (await client.query({ query, format: 'JSONEachRow', clickhouse_settings: { max_execution_time: 1800 } })).json();

const PAGES = `pages AS (
  SELECT idsitehsr, url,
    multiIf(url IN ('https://dvf.com', 'https://dvf.com/'), 'home',
      position(url, '/products/') > 0, 'product',
      position(url, '/collections/') > 0, 'collection',
      position(url, '/search') > 0, 'search',
      position(url, '/cart') > 0, 'cart',
      match(url, '/pages/(new-)?size-guide'), 'size_guide',
      match(url, '/pages/(returns-exchanges|shipping-policy|faqs|dvf-insider-faqs|contact-our-client-services-team)'), 'help',
      position(url, '/account') > 0, 'account',
      position(url, '/pages/') > 0, 'content', 'other') AS pc,
    multiIf(pc = 'product', extract(url, '/products/([^/?#]+)'),
      pc = 'collection', extract(url, '/collections/([^/?#]+)'),
      pc IN ('help', 'size_guide', 'content'), extract(url, '/pages/([^/?#]+)'), '') AS handle
  FROM (SELECT idsitehsr, JSONExtractString(arrayElement(JSONExtractArrayRaw(ifNull(any(match_page_rules), '[]')), 1), 'value') AS url
        FROM default.site_hsr WHERE idsite = ${IDSITE} GROUP BY idsitehsr))`;

// One label per click. Order matters: the waitlist button sits inside the Add to Bag wrapper,
// and the size-guide modal sits inside the size selector.
const CLICK_CLASS = `multiIf(
  s LIKE '%csm-cookie-consent%', 'cookie',
  s LIKE '%pushowl%', 'push_optin',
  s LIKE '%md-modal%' OR s LIKE '%md-btn%' OR s LIKE '%md-form%', 'locale_modal',
  match(s, '^body#[a-z0-9_-]+ > div(:nth-child\\\\(\\\\d+\\\\))? > div > div(:nth-child\\\\(\\\\d+\\\\))? > div > div > div > div > (div > )?button'), 'popup_close',
  match(s, '^body#[a-z0-9_-]+ > div(:nth-child\\\\(\\\\d+\\\\))? > div > div(:nth-child\\\\(\\\\d+\\\\))? > div > div > div > div > (div > )?form'), 'popup_form',
  s LIKE '%quick-add-product%', 'quick_add',
  s LIKE '%product-form > form > div > div:nth-child(2) > div:nth-child(2)%', 'pdp_buy_now',
  s LIKE '%product-form > form > div > div:nth-child(2) > div:nth-child(1) > div > button%', 'pdp_waitlist',
  s LIKE '%product-form > form > div > div:nth-child(2) > div%', 'pdp_add_to_bag',
  s LIKE '%selector-wrapper--size%product-modal > a%', 'pdp_size_guide_open',
  s LIKE '%selector-wrapper--size%sizeguidetable%', 'pdp_size_guide_table',
  s LIKE '%selector-wrapper--size%product-modal > dialog > div > div > button%', 'pdp_size_guide_close',
  s LIKE '%selector-wrapper--size%product-modal%', 'pdp_size_guide_other',
  s LIKE '%selector-wrapper--size%', 'pdp_size_option',
  s LIKE 'main#maincontent%> collapsible-elements > div > details > summary%',
    concat('pdp_acc_', extract(s, 'div:nth-child\\\\((\\\\d+)\\\\) > collapsible-elements > div > details > summary')),
  s LIKE 'main#maincontent%> collapsible-elements > div > details > div%> a%',
    concat('pdp_acc_link_', extract(s, 'div:nth-child\\\\((\\\\d+)\\\\) > collapsible-elements > div > details > div')),
  s LIKE 'main#maincontent%modal-content%', 'pdp_reviews',
  s LIKE '%product-images%' OR s LIKE '%zoom-images%' OR s LIKE '%pswp%', 'pdp_gallery',
  s LIKE 'main#maincontent%fieldset > div > div > a%', 'pdp_color_swatch',
  s LIKE '%quantity-counter > a%', 'cart_remove',
  s LIKE '%cart__quantity-plus%', 'cart_qty_plus',
  s LIKE '%cart__quantity-minus%', 'cart_qty_minus',
  s LIKE '%quantity-counter%input%', 'cart_qty_input',
  s LIKE '%quantity-counter%', 'cart_qty_other',
  s LIKE 'form#cartform > div > div.cart__buttons-all%' AND s NOT LIKE '%lgw-%', 'drawer_checkout',
  s LIKE 'form#cartform > div > div.cart__aside%button%', 'cartpage_checkout',
  s LIKE '%lgw-%', 'cart_gift_widget',
  s LIKE 'cart-drawer%cart-block--header%button%', 'drawer_close',
  s LIKE '%addtocart--api-product-upsell%' OR s LIKE '%nosto--minicart%' OR s LIKE '%cart__recs%', 'cart_recs',
  s LIKE 'cart-drawer%' OR s LIKE 'form#cartform%', 'cart_other',
  s LIKE '%header-search-popdown > details > div > div > div > div > button%', 'search_close',
  s LIKE '%header-search-popdown > details > summary%', 'search_open',
  s LIKE '%header-search-popdown%' OR s LIKE '%predictive-search%', 'search_use',
  match(s, 'header__mobile__left > div(:nth-child\\\\(\\\\d+\\\\))? > button'), 'menu_open',
  (s LIKE '%mobile-menu%' OR s LIKE '%header-drawer%' OR s LIKE '%rs-mobile-nav%' OR s LIKE '%header__desktop__bar__c%' OR s LIKE '%meganav%')
    AND match(s, '> a(:nth-child\\\\(\\\\d+\\\\))?[.a-z0-9_-]*( > [a-z0-9]+(:nth-child\\\\(\\\\d+\\\\))?[.a-z0-9_-]*)?$'), 'menu_link',
  s LIKE '%mobile-menu%' OR s LIKE '%header-drawer%' OR s LIKE '%rs-mobile-nav%' OR s LIKE '%header__desktop__bar__c%' OR s LIKE '%meganav%', 'menu_toggle',
  s LIKE '%header__cart%' OR s LIKE '%cart-count%' OR s LIKE '%header__mobile__right%', 'header_cart',
  s LIKE '%page-header%' OR s LIKE '%header__wrapper%', 'header_other',
  s LIKE '%footer%', 'footer',
  s LIKE 'main#maincontent%product-item%', 'content_product_tile',
  s LIKE 'main#maincontent%', 'content_other',
  'other')`;

const BOT = `NOT (rn = 'facebook' AND med = '' AND camp = '' AND dev = 1)`;

const jobs = {
  click_class_check: `
SELECT cls, count() clicks, uniqExact(idvisit) visits, any(s) example,
  topK(3)(substring(replaceRegexpAll(s, ':nth-child\\\\(\\\\d+\\\\)', ''), greatest(1, length(s) - 140))) top_tails
FROM (SELECT idvisit, lower(idselector) s, ${CLICK_CLASS} cls FROM default.udp_clicksce_clicks
      WHERE idsite = ${IDSITE} AND server_date BETWEEN '2026-09-01' AND '2026-09-30')
GROUP BY cls ORDER BY visits DESC`,

  daily_funnel: `
WITH v AS (
  SELECT idvisit, min(server_date) d, argMin(config_device_type, visit_first_action_time) dev,
    lower(argMin(ifNull(referer_name, ''), visit_first_action_time)) rn, lower(argMin(ifNull(custom_var_v1, ''), visit_first_action_time)) med,
    argMin(ifNull(custom_var_v4, ''), visit_first_action_time) camp
  FROM default.udp_hsrce_visits WHERE idsite = ${IDSITE} AND server_date BETWEEN '${D0}' AND '${V1}' GROUP BY idvisit HAVING ${BOT}),
ev AS (SELECT idvisit, max(event_type = 'homepage_viewed') e_home, max(event_type = 'collection_viewed') e_coll, max(event_type = 'product_viewed') e_pdp,
    max(event_type = 'add_to_cart') e_atc, max(event_type = 'checkout_started') e_co, max(event_type = 'checkout_completed') e_done
  FROM default.journey_events_map WHERE idsite = ${IDSITE} AND server_date BETWEEN '${D0}' AND '${V1}' GROUP BY idvisit),
o AS (SELECT toUInt64(idvisit) idvisit, uniqExact(idorder) n, sum(r) rev
  FROM (SELECT idvisit, idorder, any(revenue) r FROM default.udp_conversions FINAL WHERE idsite = ${IDSITE} AND server_date BETWEEN '${D0}' AND '${V1}' GROUP BY idvisit, idorder) GROUP BY idvisit)
SELECT toString(v.d) d, v.dev dev, count() visits, sum(ifNull(ev.e_home, 0)) home_visits, sum(ifNull(ev.e_coll, 0)) coll_visits, sum(ifNull(ev.e_pdp, 0)) pdp_visits,
  sum(ifNull(ev.e_atc, 0)) atc_visits, sum(ifNull(ev.e_co, 0)) co_visits, sum(ifNull(ev.e_done, 0)) done_visits,
  countIf(ifNull(o.n, 0) > 0) buyer_visits, sum(ifNull(o.n, 0)) orders, sum(ifNull(o.rev, 0)) revenue
FROM v LEFT JOIN ev ON ev.idvisit = toUInt64(v.idvisit) LEFT JOIN o ON o.idvisit = toUInt64(v.idvisit)
GROUP BY d, dev ORDER BY d, dev`,

  events_daily: `
WITH ev AS (SELECT idvisit, min(server_date) d, argMin(device_type, server_time) dev,
    max(event_type = 'homepage_viewed') e_home, max(event_type = 'collection_viewed') e_coll, max(event_type = 'product_viewed') e_pdp,
    max(event_type = 'add_to_cart') e_atc, max(event_type = 'cart_viewed') e_cartpage, max(event_type = 'checkout_started') e_co,
    max(event_type = 'checkout_completed') e_done
  FROM default.journey_events_map WHERE idsite = ${IDSITE} AND server_date BETWEEN '${D0}' AND '${V1}' GROUP BY idvisit),
o AS (SELECT toUInt64(idvisit) idvisit, uniqExact(idorder) n, sum(r) rev
  FROM (SELECT idvisit, idorder, any(revenue) r FROM default.udp_conversions FINAL WHERE idsite = ${IDSITE} AND server_date BETWEEN '${D0}' AND '${V1}' GROUP BY idvisit, idorder) GROUP BY idvisit)
SELECT toString(ev.d) d, ev.dev dev, count() event_visits, sum(e_home) home_visits, sum(e_coll) coll_visits, sum(e_pdp) pdp_visits, sum(e_atc) atc_visits,
  sum(e_cartpage) cartpage_visits, sum(e_co) co_visits, sum(e_done) done_visits, countIf(ifNull(o.n, 0) > 0) buyer_visits, sum(ifNull(o.n, 0)) orders, sum(ifNull(o.rev, 0)) revenue
FROM ev LEFT JOIN o ON o.idvisit = ev.idvisit GROUP BY d, dev ORDER BY d, dev`,

  orders: `
WITH o AS (SELECT idorder, any(idvisit) idvisit, any(revenue) rev, any(server_date) d, any(device_type) odev
  FROM default.udp_conversions FINAL WHERE idsite = ${IDSITE} AND server_date BETWEEN '${D0}' AND '${V1}' GROUP BY idorder),
it AS (SELECT idorder, count() item_rows, sum(quantity) units, uniqExact(idaction_sku) skus, any(title) title, any(price) first_price, sum(price * quantity) item_value
  FROM default.conversion_item WHERE idsite = ${IDSITE} AND server_time >= '2026-07-31' AND server_time < '2026-10-13' AND deleted = 0 GROUP BY idorder)
SELECT lower(hex(cityHash64(o.idorder))) oid, toString(o.idvisit) idvisit, toString(o.d) d, o.odev odev, o.rev rev,
  ifNull(it.item_rows, 0) item_rows, ifNull(it.units, 0) units, ifNull(it.skus, 0) skus, ifNull(it.title, '') title, ifNull(it.first_price, 0) price, ifNull(it.item_value, 0) item_value
FROM o LEFT JOIN it USING idorder ORDER BY o.d`,

  visits: `
WITH ${PAGES},
v AS (
  SELECT idvisit, min(server_date) d, min(visit_first_action_time) t0,
    argMin(ifNull(config_id, ''), visit_first_action_time) cid0,
    argMin(config_device_type, visit_first_action_time) dev,
    argMin(referer_type, visit_first_action_time) rt,
    lower(argMin(ifNull(referer_name, ''), visit_first_action_time)) rn,
    lower(argMin(ifNull(custom_var_v1, ''), visit_first_action_time)) med,
    argMin(ifNull(custom_var_v4, ''), visit_first_action_time) camp,
    toUInt8(argMin(ifNull(visitor_returning, false), visit_first_action_time)) ret
  FROM default.udp_hsrce_visits WHERE idsite = ${IDSITE} AND server_date BETWEEN '${V0}' AND '${V1}' GROUP BY idvisit HAVING ${BOT}),
ev AS (SELECT idvisit,
    minIf(server_time, event_type = 'add_to_cart') t_atc, minIf(server_time, event_type = 'checkout_started') t_co,
    minIf(server_time, event_type = 'checkout_completed') t_done,
    max(event_type = 'add_to_cart') e_atc, max(event_type = 'checkout_started') e_co, max(event_type = 'checkout_completed') e_done,
    max(event_type = 'product_viewed') e_pdp, max(event_type = 'homepage_viewed') e_home, max(event_type = 'collection_viewed') e_coll,
    max(event_type = 'search_submitted') e_search, max(event_type = 'cart_viewed') e_cartpage
  FROM default.journey_events_map WHERE idsite = ${IDSITE} AND server_date BETWEEN '${V0}' AND '${V1}' GROUP BY idvisit),
o AS (SELECT toUInt64(idvisit) idvisit, uniqExact(idorder) n, sum(r) rev
  FROM (SELECT idvisit, idorder, any(revenue) r FROM default.udp_conversions FINAL WHERE idsite = ${IDSITE} AND server_date BETWEEN '${V0}' AND '${V1}' GROUP BY idvisit, idorder) GROUP BY idvisit),
pv AS (SELECT toUInt64(p.idvisit) idvisit,
    arrayStringConcat(arrayMap(x -> concat(tupleElement(x, 2), ':', tupleElement(x, 3)),
      arraySort(x -> tupleElement(x, 1), groupArray(tuple(p.server_time, ifNull(pages.pc, 'untracked'), ifNull(pages.handle, ''))))), '|') seq
  FROM default.udp_hsrce_pageviews p LEFT JOIN pages ON toUInt64(p.idsitehsr) = pages.idsitehsr
  WHERE p.idsite = ${IDSITE} AND p.server_date BETWEEN '${V0}' AND '${V1}' GROUP BY p.idvisit),
cl AS (SELECT toUInt64(idvisit) idvisit, count() clicks, sumMap(map(cls, toUInt32(1))) cmap
  FROM (SELECT idvisit, lower(idselector) s, ${CLICK_CLASS} cls FROM default.udp_clicksce_clicks
        WHERE idsite = ${IDSITE} AND server_date BETWEEN '${V0}' AND '${V1}')
  GROUP BY idvisit)
SELECT toString(v.idvisit) idvisit, toString(v.d) d, toString(v.t0) t0, lower(hex(cityHash64(v.cid0))) cid, v.cid0 = '' cid_blank, v.dev dev, v.rt rt, v.rn rn, v.med med, v.camp camp, v.ret ret,
  ifNull(ev.e_atc, 0) e_atc, ifNull(ev.e_co, 0) e_co, ifNull(ev.e_done, 0) e_done, ifNull(ev.e_pdp, 0) e_pdp, ifNull(ev.e_home, 0) e_home,
  ifNull(ev.e_coll, 0) e_coll, ifNull(ev.e_search, 0) e_search, ifNull(ev.e_cartpage, 0) e_cartpage,
  if(ifNull(ev.e_atc, 0) = 1, toString(ev.t_atc), '') t_atc, if(ifNull(ev.e_co, 0) = 1, toString(ev.t_co), '') t_co, if(ifNull(ev.e_done, 0) = 1, toString(ev.t_done), '') t_done,
  ifNull(o.n, 0) n, ifNull(o.rev, 0) rev, ifNull(pv.seq, '') seq, ifNull(cl.clicks, 0) clicks, cl.cmap cmap
FROM v LEFT JOIN ev ON ev.idvisit = toUInt64(v.idvisit) LEFT JOIN o ON o.idvisit = toUInt64(v.idvisit)
LEFT JOIN pv ON pv.idvisit = toUInt64(v.idvisit) LEFT JOIN cl ON cl.idvisit = toUInt64(v.idvisit)`,

  pdp_pageviews: `
WITH ${PAGES},
pp AS (SELECT p.idloghsr idloghsr, toString(p.idvisit) idvisit, p.device_type dev, toString(p.server_time) t, toString(p.server_date) d, pages.handle handle,
    ifNull(p.time_on_page, 0) top_ms, ifNull(p.scroll_y_max_relative, 0) scroll, ifNull(p.viewport_w_px, 0) vw
  FROM default.udp_hsrce_pageviews p JOIN pages ON toUInt64(p.idsitehsr) = pages.idsitehsr
  WHERE p.idsite = ${IDSITE} AND p.server_date BETWEEN '${V0}' AND '${V1}' AND pages.pc = 'product'),
c AS (SELECT idloghsr, sumMap(map(cls, toUInt32(1))) cmap,
    minIf(tsl, cls = 'pdp_size_guide_open') t_sg, minIf(tsl, startsWith(cls, 'pdp_acc_')) t_acc, minIf(tsl, cls = 'pdp_size_option') t_size,
    minIf(tsl, cls = 'pdp_add_to_bag') t_add_first, maxIf(tsl, cls = 'pdp_add_to_bag') t_add_last, minIf(tsl, cls = 'pdp_buy_now') t_bin,
    uniqExactIf(extract(s, 'legend > span > div > span:nth-child\\\\((\\\\d+)\\\\)'), cls = 'pdp_size_option') size_targets
  FROM (SELECT idloghsr, lower(idselector) s, ifNull(time_since_load, 0) tsl, ${CLICK_CLASS} cls FROM default.udp_clicksce_clicks
        WHERE idsite = ${IDSITE} AND server_date BETWEEN '${V0}' AND '${V1}')
  GROUP BY idloghsr)
SELECT pp.*, c.cmap cmap, ifNull(c.t_sg, 0) t_sg, ifNull(c.t_acc, 0) t_acc, ifNull(c.t_size, 0) t_size, ifNull(c.t_add_first, 0) t_add_first,
  ifNull(c.t_add_last, 0) t_add_last, ifNull(c.t_bin, 0) t_bin, ifNull(c.size_targets, 0) size_targets
FROM pp LEFT JOIN c ON c.idloghsr = pp.idloghsr`,

  home_pageviews: `
WITH ${PAGES},
hp AS (SELECT p.idloghsr idloghsr, toString(p.idvisit) idvisit, p.device_type dev, toString(p.server_time) t, toString(p.server_date) d,
    ifNull(p.time_on_page, 0) top_ms, ifNull(p.scroll_y_max_relative, 0) scroll, ifNull(p.fold_y_relative, 0) fold, ifNull(p.viewport_h_px, 0) vh, ifNull(p.scroll_height, 0) sh
  FROM default.udp_hsrce_pageviews p JOIN pages ON toUInt64(p.idsitehsr) = pages.idsitehsr
  WHERE p.idsite = ${IDSITE} AND p.server_date BETWEEN '${V0}' AND '${V1}' AND pages.pc = 'home'),
c AS (SELECT idloghsr, sumMap(map(cls, toUInt32(1))) cmap,
    argMin(cls, tsl) first_cls, min(tsl) first_tsl,
    argMinIf(cls, tsl, cls NOT IN ('cookie', 'popup_close', 'popup_form', 'push_optin', 'locale_modal', 'search_close', 'other')) first_nav_cls,
    minIf(tsl, cls NOT IN ('cookie', 'popup_close', 'popup_form', 'push_optin', 'locale_modal', 'search_close', 'other')) first_nav_tsl
  FROM (SELECT idloghsr, lower(idselector) s, ifNull(time_since_load, 0) tsl, ${CLICK_CLASS} cls FROM default.udp_clicksce_clicks
        WHERE idsite = ${IDSITE} AND server_date BETWEEN '${V0}' AND '${V1}')
  GROUP BY idloghsr)
SELECT hp.*, c.cmap cmap, ifNull(c.first_cls, '') first_cls, ifNull(c.first_tsl, 0) first_tsl, ifNull(c.first_nav_cls, '') first_nav_cls, ifNull(c.first_nav_tsl, 0) first_nav_tsl
FROM hp LEFT JOIN c ON c.idloghsr = hp.idloghsr`,
};

const only = process.argv.slice(2);
for (const [name, q] of Object.entries(jobs)) {
  if (only.length && !only.includes(name)) continue;
  const t = Date.now();
  try {
    const rows = await run(q);
    fs.writeFileSync(`${OUT}/${name}.json`, JSON.stringify(rows));
    console.log(name, rows.length, `${((Date.now() - t) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.error(name, 'ERR', e.message.slice(0, 600));
  }
}
await client.close();
