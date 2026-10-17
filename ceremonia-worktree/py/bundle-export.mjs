/**
 * Visit, order, page, and pipeline extracts for one site's analyst bundle.
 * Usage: node py/bundle-export.mjs --site orchestration/sites/<slug>/site.json
 *   --window-start YYYY-MM-DD --window-end YYYY-MM-DD --out <extract dir>
 * Writes the extracts and meta.json to the --out directory.
 */
import { sessionUtmSql, tagUtmCte } from '../src/adapters/_lib/sql.js';
import { clickHouseConfig, clickHouseDatabase, createClickHouseClient } from '../src/composition/clickhouse.js';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { declaredSegmentation } from '../src/application/segmentation/registry.js';
import { loadSegmentationCatalog } from '../src/catalog/segmentations.js';
import { loadSegmentationRegistry } from '../src/composition/segmentations.js';
import { LABELS, normalizedUrlSql, pageClassSql } from '../src/domain/page-class/index.js';
import { repairStrippedEscapes } from '../src/domain/text-repair.js';
import { parseFlags, valueOf, window as windowFlags } from '../src/application/commands/args.js';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The platform as the bundle prints it: `shopify` reads Shopify. */
const displayPlatform = (platform) => (platform ? platform[0].toUpperCase() + platform.slice(1) : '');

/**
 * What one extract needs: the site spec's identity and analysed page, and the
 * job's window. `periods` and `readingNotes` are carried when the site names them.
 *
 * @param {{slug: string, name?: string, domain: string, idsite: number, currency?: string, platform?: string,
 *   focus?: {path: string, label?: string, idsitehsr: number}, periods?: Array<object>, readingNotes?: object}} site
 * @param {{start: string, end: string}} window
 */
export function exportSpec(site, window) {
  const focus = site.focus ?? {};
  if (!Number.isInteger(site.idsite) || site.idsite <= 0) throw new Error(`${site.slug}: site.json has no idsite`);
  if (!focus.path || !Number.isInteger(focus.idsitehsr)) throw new Error(`${site.slug}: site.json has no focus {path, label, idsitehsr}`);
  if (!ISO_DAY.test(window?.start ?? '') || !ISO_DAY.test(window?.end ?? '') || window.start > window.end) {
    throw new Error(`${site.slug}: the window needs a start and an end as YYYY-MM-DD, start first`);
  }
  const spec = {
    slug: site.slug,
    name: site.name ?? site.slug,
    domain: site.domain,
    idsite: site.idsite,
    currency: site.currency ?? 'USD',
    platform: displayPlatform(site.platform),
    window0: window.start,
    window1: window.end,
    focusPath: focus.path,
    focusLabel: focus.label ?? focus.path,
    idsitehsr: focus.idsitehsr,
  };
  if (site.periods) spec.periods = sitePeriods(site.periods, spec);
  if (site.readingNotes) spec.readingNotes = site.readingNotes;
  return spec;
}

/**
 * The periods the extract labels visits with. A site with no calendar gets
 * pre (the 14 days before the window) and the window's two calendar halves,
 * with the first half as the price baseline.
 */
export function periodsOf(spec) {
  if (spec.periods) return spec.periods;
  const firstEnd = addDays(spec.window0, 14);
  return [
    { name: 'pre', start: addDays(spec.window0, -14), end: addDays(spec.window0, -1) },
    { name: 'first', start: spec.window0, end: firstEnd, baseline: true },
    { name: 'second', start: addDays(firstEnd, 1), end: spec.window1 },
  ];
}

/**
 * A site calendar from site.json: `[{name, end, baseline?, about?}, ..., {name}]`.
 * The first period starts at the visit extract's start, each next one the day
 * after the previous end, and the last ends with the window. The baseline is
 * the flagged period, else the first one inside the window.
 */
export function sitePeriods(declared, spec) {
  if (!Array.isArray(declared) || declared.length < 2) throw new Error(`${spec.slug}: site.json periods needs at least two periods`);
  const periods = [];
  let start = addDays(spec.window0, -14);
  declared.forEach((period, i) => {
    const last = i === declared.length - 1;
    if (!/^[a-z][a-z0-9_]*$/.test(period?.name ?? '')) throw new Error(`${spec.slug}: period ${i + 1} needs a lower-case name`);
    const end = last ? spec.window1 : period.end;
    if (!ISO_DAY.test(end ?? '') || end < start || end > spec.window1) {
      throw new Error(`${spec.slug}: period ${period.name} needs an end from ${start} to ${spec.window1}`);
    }
    const resolved = { name: period.name, start, end };
    if (period.baseline) resolved.baseline = true;
    if (period.about) resolved.about = period.about;
    periods.push(resolved);
    start = addDays(end, 1);
  });
  if (!periods.some((p) => p.baseline)) {
    const inWindow = periods.find((p) => p.start >= spec.window0);
    if (inWindow) inWindow.baseline = true;
  }
  return periods;
}

/** The period name for a date column: before the second period, then up to each end, else the last. */
export function periodSql(periods, column) {
  const [first, ...rest] = periods;
  const last = rest.pop();
  const parts = [`${column} < '${(rest[0] ?? last).start}'`, `'${first.name}'`];
  for (const period of rest) parts.push(`${column} <= '${period.end}'`, `'${period.name}'`);
  return `multiIf(${parts.join(', ')}, '${last.name}')`;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function client() {
  return createClickHouseClient(clickHouseConfig(process.env), {
    requestTimeoutMs: 3_600_000,
    settings: { output_format_json_quote_denormals: 0, max_execution_time: 3600, http_headers_progress_interval_ms: 15000 },
  });
}

/** Page class over an already-normalized `url` column, with the bundle labels. */
export function pageClass() {
  return pageClassSql('url', { labels: LABELS.bundle, normalize: false });
}

/** One row per heatmap page: its decoded target URL and page class. */
function pagesCte(idsite) {
  const raw = `extract(replaceAll(ifNull(any(match_page_rules), ''), '''', '"'), '"value":"([^"]+)')`;
  return `pages AS (
  SELECT idsitehsr, url, ${pageClass()} AS pc
  FROM (
    SELECT idsitehsr, ${normalizedUrlSql(raw)} AS url
    FROM default.site_hsr WHERE idsite = ${idsite} GROUP BY idsitehsr
  )
)`;
}

/** The segmentation fields as the visit extract aliases them. */
export const BUNDLE_COLUMNS = Object.freeze({
  referer_type: 'rt',
  referer_name: 'rn',
  utm_medium: 'med',
  utm_campaign: 'camp',
  source_or_referrer: 'src',
});

/**
 * The bundle's `ch` and `link_ch` segmentations: the shipped `channel` and
 * `link_channel`, or a site's from the registry, with its overrides.
 * @param {{forSite: (idsite: number) => ReadonlyMap<string, import('../src/ports/segmentation.js').Segmentation>}} [registry]
 * @param {number} [idsite]
 */
export function bundleChannels(registry, idsite) {
  if (registry) {
    const site = registry.forSite(idsite);
    return { visit: site.get('channel'), link: site.get('link_channel') };
  }
  const shipped = (id) => declaredSegmentation(loadSegmentationCatalog().find((seg) => seg.id === id));
  return { visit: shipped('channel'), link: shipped('link_channel') };
}

/** Order rows with Latin-1 titles whose JSON escapes lost their backslash restored. */
export function repairOrderTitles(rows) {
  return rows.map((row) => ({ ...row, title: repairStrippedEscapes(row.title) }));
}

/**
 * @param {ReturnType<typeof exportSpec> & {channels?: ReturnType<typeof bundleChannels>}} site
 *   `channels` defaults to the shipped declarations
 * @param {{index: number, count: number} | null} [shard]
 */
export function visitSql(site, shard = null) {
  const { idsite, window0, window1 } = site;
  const channels = site.channels ?? bundleChannels();
  const hist = addDays(window0, -44);
  const pre = addDays(window0, -14);
  if (shard && (!Number.isInteger(shard.index) || !Number.isInteger(shard.count) || shard.count < 1 || shard.index < 0 || shard.index >= shard.count)) {
    throw new Error('visit shard needs an index from 0 through count - 1');
  }
  const shardHaving = shard
    ? `\n  HAVING modulo(cityHash64(if(cid = '', concat('~', toString(idvisit)), cid)), ${shard.count}) = ${shard.index}`
    : '';
  const shardVisits = shard ? ' AND toUInt64(idvisit) IN (SELECT toUInt64(idvisit) FROM v_rows)' : '';
  const vRows = `v_rows AS (
  SELECT idvisit,
    min(server_date) AS d,
    argMin(ifNull(config_id, ''), visit_first_action_time) AS cid,
    argMin(referer_type, visit_first_action_time) AS rt,
    lower(argMin(ifNull(referer_name, ''), visit_first_action_time)) AS rn,
    lower(argMin(ifNull(custom_var_v1, ''), visit_first_action_time)) AS med,
    argMin(ifNull(custom_var_v4, ''), visit_first_action_time) AS camp,
    lower(argMin(ifNull(custom_var_k5, ''), visit_first_action_time)) AS utm,
    argMin(config_device_type, visit_first_action_time) AS dev,
    toUInt8(argMin(ifNull(visitor_returning, false), visit_first_action_time)) AS ret,
    argMin(ifNull(visitor_count_visits, 0), visit_first_action_time) AS nvisits,
    min(visit_first_action_time) AS t0,
    argMin(ifNull(location_country, ''), visit_first_action_time) AS country
  FROM default.udp_hsrce_visits
  WHERE idsite = ${idsite} AND server_date BETWEEN '${hist}' AND '${window1}'
  GROUP BY idvisit${shardHaving}
)`;
  const tags = tagUtmCte('v_tags', {
    keys: [['idvisit', 'CAST(idvisit AS UInt64)']],
    idsite: `= ${idsite}`,
    from: `'${hist}'`,
    to: `'${window1}'`,
    and: shardVisits,
  });
  const visitCtes = shard ? `${vRows},\n${tags}` : `${tags},\n${vRows}`;
  return `
WITH ${pagesCte(idsite)},${visitCtes},
v AS (
  SELECT r.* REPLACE (${sessionUtmSql('utm_source', 't', 'r.utm')} AS utm, ${sessionUtmSql('utm_medium', 't', 'r.med')} AS med, ${sessionUtmSql('utm_campaign', 't', 'r.camp')} AS camp)
  FROM v_rows AS r
  LEFT JOIN v_tags AS t ON t.idvisit = CAST(r.idvisit AS UInt64)
),
o AS (
  SELECT idvisit, uniqExact(idorder) AS n, sum(r) AS rev
  FROM (
    SELECT idvisit, idorder, any(revenue) AS r
    FROM default.udp_conversions FINAL
    WHERE idsite = ${idsite} AND server_date BETWEEN '${hist}' AND '${window1}'${shardVisits}
    GROUP BY idvisit, idorder
  ) GROUP BY idvisit
),
pv_raw AS (
  SELECT p.idvisit AS idvisit,
    count() AS pvs,
    argMin(pages.url, p.server_time) AS eurl,
    arraySort(x -> tupleElement(x, 1), groupArray(tuple(p.server_time, ifNull(pages.pc, 'untracked')))) AS seq,
    sum(least(toUInt64(ifNull(time_on_page, 0)), 600000)) / 1000 AS secs,
    maxIf(ifNull(scroll_y_max_relative, 0), pages.pc = 'home') AS sc_home,
    maxIf(ifNull(scroll_y_max_relative, 0), pages.pc = 'product') AS sc_prod,
    maxIf(ifNull(scroll_y_max_relative, 0), pages.pc = 'collection') AS sc_coll,
    max(ifNull(scroll_y_max_relative, 0)) AS sc_max,
    sumIf(least(toUInt64(ifNull(time_on_page, 0)), 600000), pages.pc = 'product') / 1000 AS secs_prod,
    uniqExactIf(pages.url, pages.pc = 'product') AS n_prod_urls,
    toUInt8(max(pages.pc = 'home')) AS saw_home,
    toUInt8(max(pages.pc = 'product')) AS saw_product,
    toUInt8(max(pages.pc = 'collection')) AS saw_collection,
    toUInt8(max(pages.pc = 'cart')) AS saw_cart,
    toUInt8(max(pages.pc = 'search')) AS saw_search,
    toUInt8(max(pages.pc = 'account')) AS saw_account,
    toUInt8(max(pages.pc = 'content')) AS saw_content
  FROM default.udp_hsrce_pageviews AS p
  LEFT JOIN pages USING idsitehsr
  WHERE p.idsite = ${idsite} AND p.server_date BETWEEN '${hist}' AND '${window1}'${shard ? ' AND toUInt64(p.idvisit) IN (SELECT toUInt64(idvisit) FROM v_rows)' : ''}
  GROUP BY p.idvisit
),
pv AS (
  SELECT idvisit, pvs, eurl, secs, sc_home, sc_prod, sc_coll, sc_max, secs_prod, n_prod_urls,
    saw_home, saw_product, saw_collection, saw_cart, saw_search, saw_account, saw_content,
    arrayStringConcat(arraySlice(arrayCompact(arrayMap(x -> tupleElement(x, 2), seq)), 1, 3), '>') AS journey3,
    tupleElement(arrayElement(seq, 1), 2) AS entry,
    toUInt8(position(arrayStringConcat(arrayCompact(arrayMap(x -> tupleElement(x, 2), seq)), '>'), 'collection>product') > 0) AS coll_to_prod
  FROM pv_raw
),
ev AS (
  SELECT toInt64(idvisit) AS idvisit,
    countIf(event_type = 'add_to_cart') AS e_atc,
    countIf(event_type = 'search_submitted') AS e_search,
    countIf(event_type = 'checkout_started') AS e_co
  FROM default.journey_events_map
  WHERE idsite = ${idsite} AND server_date BETWEEN '${hist}' AND '${window1}'${shardVisits}
  GROUP BY idvisit
),
cl AS (
  SELECT idvisit, count() AS clicks,
    max(s LIKE '%cart%' OR s LIKE '%bag%') AS c_cart,
    max(s LIKE '%menu%' OR s LIKE '%drawer%' OR s LIKE '%nav%') AS c_menu,
    max(s LIKE '%search%') AS c_search,
    max(s LIKE '%swatch%' OR s LIKE '%color%' OR s LIKE '%colour%') AS c_swatch,
    max(s LIKE '%add-to-cart%' OR s LIKE '%addtocart%' OR s LIKE '%add_to_cart%' OR s LIKE '%product-form%') AS c_add,
    max(s LIKE '%checkout%') AS c_checkout,
    max(s LIKE '%shop-pay%' OR s LIKE '%paypal%' OR s LIKE '%afterpay%' OR s LIKE '%klarna%' OR s LIKE '%affirm%') AS c_pay,
    max(s LIKE '%review%' OR s LIKE '%yotpo%' OR s LIKE '%okendo%' OR s LIKE '%judgeme%') AS c_reviews,
    max(s LIKE '%faq%' OR s LIKE '%accordion%' OR s LIKE '%collapsible%') AS c_faq,
    max(s LIKE '%cookie%') AS c_cookie,
    max(s LIKE '%popup%' OR s LIKE '%klaviyo%' OR s LIKE '%needsclick%') AS c_popup,
    max(s LIKE '%size%') AS c_size
  FROM (
    SELECT idvisit, lower(idselector) AS s
    FROM default.udp_clicksce_clicks
    WHERE idsite = ${idsite} AND server_date BETWEEN '${hist}' AND '${window1}'${shardVisits}
  )
  GROUP BY idvisit
),
tg AS (
  SELECT idvisit, any(session_tags) AS tags
  FROM default.udp_session_tags
  WHERE idsite = ${idsite} AND server_date BETWEEN '${hist}' AND '${window1}' AND session_tags NOT IN ('{}', '')${shardVisits}
  GROUP BY idvisit
),
joined AS (
  SELECT toString(v.idvisit) AS idvisit, toString(v.d) AS d, v.cid AS cid, v.rt AS rt, v.rn AS rn, v.med AS med, v.camp AS camp, v.utm AS utm,
    v.dev AS dev, v.ret AS ret, v.nvisits AS nvisits, toString(v.t0) AS t0, v.country AS country,
    ifNull(o.n, 0) AS n, ifNull(o.rev, 0) AS rev,
    ifNull(pv.pvs, 0) AS pvs, ifNull(pv.eurl, '') AS eurl, ifNull(pv.journey3, '') AS journey3, ifNull(pv.entry, '') AS entry,
    ifNull(pv.secs, 0) AS secs, ifNull(pv.sc_home, 0) AS sc_home, ifNull(pv.sc_prod, 0) AS sc_prod, ifNull(pv.sc_coll, 0) AS sc_coll,
    ifNull(pv.sc_max, 0) AS sc_max, ifNull(pv.secs_prod, 0) AS secs_prod, ifNull(pv.n_prod_urls, 0) AS n_prod_urls,
    ifNull(pv.saw_home, 0) AS saw_home, ifNull(pv.saw_product, 0) AS saw_product, ifNull(pv.saw_collection, 0) AS saw_collection,
    ifNull(pv.saw_cart, 0) AS saw_cart, ifNull(pv.saw_search, 0) AS saw_search, ifNull(pv.saw_account, 0) AS saw_account,
    ifNull(pv.saw_content, 0) AS saw_content, ifNull(pv.coll_to_prod, 0) AS coll_to_prod,
    ifNull(ev.e_atc, 0) AS e_atc, ifNull(ev.e_search, 0) AS e_search, ifNull(ev.e_co, 0) AS e_co,
    ifNull(cl.clicks, 0) AS clicks,
    ifNull(cl.c_cart, 0) AS c_cart, ifNull(cl.c_menu, 0) AS c_menu, ifNull(cl.c_search, 0) AS c_search, ifNull(cl.c_swatch, 0) AS c_swatch,
    ifNull(cl.c_add, 0) AS c_add, ifNull(cl.c_checkout, 0) AS c_checkout, ifNull(cl.c_pay, 0) AS c_pay, ifNull(cl.c_reviews, 0) AS c_reviews,
    ifNull(cl.c_faq, 0) AS c_faq, ifNull(cl.c_cookie, 0) AS c_cookie, ifNull(cl.c_popup, 0) AS c_popup, ifNull(cl.c_size, 0) AS c_size,
    JSONExtractString(ifNull(tg.tags, ''), 'utm_content') AS utm_content,
    if(v.utm != '', v.utm, v.rn) AS src,
    ${channels.visit.sql(BUNDLE_COLUMNS)} AS ch,
    toUInt32(toUnixTimestamp(v.t0)) AS ts,
    if(v.cid = '', concat('~', toString(v.idvisit)), v.cid) AS part,
    (ifNull(pv.pvs, 0) > 3 OR (ifNull(cl.clicks, 0) > 0 AND ifNull(pv.sc_max, 0) >= 250 AND ifNull(pv.secs, 0) > 60)) AS deep
  FROM v
  LEFT JOIN o ON o.idvisit = v.idvisit
  LEFT JOIN pv ON pv.idvisit = v.idvisit
  LEFT JOIN ev ON ev.idvisit = toInt64(v.idvisit)
  LEFT JOIN cl ON cl.idvisit = v.idvisit
  LEFT JOIN tg ON tg.idvisit = v.idvisit
),
scored AS (
  SELECT *,
    ${channels.link.sql(BUNDLE_COLUMNS)} AS link_ch,
    count() OVER (PARTITION BY part ORDER BY ts RANGE BETWEEN 1209600 PRECEDING AND 1 PRECEDING) AS prior_visits,
    countIf(e_atc > 0) OVER (PARTITION BY part ORDER BY ts RANGE BETWEEN 1209600 PRECEDING AND 1 PRECEDING) AS prior_atc,
    countIf(n > 0) OVER (PARTITION BY part ORDER BY ts RANGE BETWEEN 1209600 PRECEDING AND 1 PRECEDING) AS prior_buy,
    countIf(ch = 'email_sms') OVER (PARTITION BY part ORDER BY ts RANGE BETWEEN 1209600 PRECEDING AND 1 PRECEDING) AS prior_email,
    max(toUInt8(n > 0)) OVER (PARTITION BY part ORDER BY ts RANGE BETWEEN 2592000 PRECEDING AND 1 PRECEDING) AS bought30,
    max(toUInt8(e_atc > 0 OR e_co > 0)) OVER (PARTITION BY part ORDER BY ts RANGE BETWEEN 2592000 PRECEDING AND 1 PRECEDING) AS bag30,
    count() OVER (PARTITION BY part ORDER BY ts RANGE BETWEEN 2592000 PRECEDING AND 1 PRECEDING) AS prior30,
    lagInFrame(toUInt8(deep), 1, 0) OVER (PARTITION BY part ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS prev_deep,
    lagInFrame(ts, 1, toUInt32(0)) OVER (PARTITION BY part ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS prev_ts
  FROM joined
)
SELECT idvisit, d, cid, rt, rn, med, camp, utm, dev, ret, nvisits, t0, country, n, rev, pvs, eurl, journey3, entry, secs,
  sc_home, sc_prod, sc_coll, sc_max, secs_prod, n_prod_urls, saw_home, saw_product, saw_collection, saw_cart, saw_search,
  saw_account, saw_content, coll_to_prod, e_atc, e_search, e_co, clicks, c_cart, c_menu, c_search, c_swatch, c_add, c_checkout,
  c_pay, c_reviews, c_faq, c_cookie, c_popup, c_size, utm_content, src, ch, link_ch, prior_visits, prior_atc, prior_buy, prior_email,
  if(prev_ts > 0 AND ts >= prev_ts AND ts - prev_ts <= 1209600, (ts - prev_ts) / 3600, NULL) AS hrs_since_last,
  multiIf(
    cid = '', 'no_device_id',
    bought30 > 0, 'bought_before',
    bag30 > 0, 'left_bag',
    prev_ts > 0 AND ts >= prev_ts AND ts - prev_ts <= 2592000 AND prev_deep > 0, 'browsed_deeply_last_visit_no_bag',
    prior30 > 0, 'browsed_before',
    ret = 1, 'returning_last_seen_over_30d',
    'first_visit') AS hist30
FROM scored
WHERE d >= '${pre}' AND d <= '${window1}'
SETTINGS max_bytes_before_external_group_by = 4000000000,
         max_bytes_before_external_sort = 4000000000,
         join_algorithm = 'grace_hash',
         max_bytes_in_join = 4000000000
`;
}

export function ordersSql(site) {
  const from = addDays(site.window0, -30);
  const to = site.window1;
  return `
WITH o AS (
  SELECT idorder, any(idvisit) AS idvisit, any(revenue) AS rev, min(server_time) AS t, any(server_date) AS d, any(device_type) AS odev
  FROM default.udp_conversions FINAL
  WHERE idsite = ${site.idsite} AND server_date BETWEEN '${from}' AND '${to}'
  GROUP BY idorder
),
it AS (
  SELECT idorder, argMax(title, price) AS item_title, argMax(price, price) AS item_price, sum(quantity) AS qty, count() AS items
  FROM default.conversion_item
  WHERE idsite = ${site.idsite} AND server_time >= '${addDays(from, -1)}' AND server_time < '${addDays(to, 2)}' AND deleted = 0
  GROUP BY idorder
)
SELECT lower(hex(cityHash64(o.idorder))) AS oid, toString(o.idvisit) AS idvisit, toString(o.d) AS d, toString(o.t) AS t,
  o.rev AS rev, o.odev AS odev, ifNull(it.item_title, '') AS title, ifNull(it.item_price, 0) AS price, ifNull(it.qty, 0) AS qty, ifNull(it.items, 0) AS items
FROM o LEFT JOIN it USING idorder
ORDER BY o.t`;
}

export function pagePeriodSql(site) {
  const { idsite, window0, window1 } = site;
  const pre = addDays(window0, -14);
  return `
WITH ${pagesCte(idsite)},
v AS (
  SELECT idvisit, min(server_date) AS d, argMin(config_device_type, visit_first_action_time) AS dev
  FROM default.udp_hsrce_visits
  WHERE idsite = ${idsite} AND server_date BETWEEN '${pre}' AND '${window1}'
  GROUP BY idvisit
),
o AS (
  SELECT idvisit, uniqExact(idorder) AS n, sum(r) AS rev
  FROM (
    SELECT idvisit, idorder, any(revenue) AS r
    FROM default.udp_conversions FINAL
    WHERE idsite = ${idsite} AND server_date BETWEEN '${pre}' AND '${window1}'
    GROUP BY idvisit, idorder
  ) GROUP BY idvisit
),
pv AS (
  SELECT p.idvisit AS idvisit, pages.url AS url, pages.pc AS pc
  FROM default.udp_hsrce_pageviews AS p LEFT JOIN pages USING idsitehsr
  WHERE p.idsite = ${idsite} AND p.server_date BETWEEN '${pre}' AND '${window1}'
  GROUP BY p.idvisit, pages.url, pages.pc
),
ent AS (
  SELECT p.idvisit AS idvisit, argMin(pages.url, p.server_time) AS eurl
  FROM default.udp_hsrce_pageviews AS p LEFT JOIN pages USING idsitehsr
  WHERE p.idsite = ${idsite} AND p.server_date BETWEEN '${pre}' AND '${window1}'
  GROUP BY p.idvisit
)
SELECT url, pc,
  ${periodSql(periodsOf(site), 'v.d')} AS period,
  v.dev AS dev,
  count() AS visits,
  countIf(ifNull(o.n, 0) > 0) AS buyer_visits,
  sum(ifNull(o.rev, 0)) AS buyer_visit_revenue,
  countIf(ent.eurl = url) AS entries,
  countIf(ent.eurl = url AND ifNull(o.n, 0) > 0) AS entry_buyer_visits
FROM pv
JOIN v ON v.idvisit = pv.idvisit
LEFT JOIN o ON o.idvisit = pv.idvisit
LEFT JOIN ent ON ent.idvisit = pv.idvisit
GROUP BY url, pc, period, dev
HAVING visits >= 10
ORDER BY visits DESC`;
}

export function hvSql(site, hv) {
  const { idsite, window0, window1 } = site;
  return `
WITH ${pagesCte(idsite)},
v AS (
  SELECT idvisit, argMin(ifNull(config_id, ''), visit_first_action_time) AS cid
  FROM default.udp_hsrce_visits
  WHERE idsite = ${idsite} AND server_date BETWEEN '${window0}' AND '${window1}'
  GROUP BY idvisit
),
o AS (
  SELECT idvisit, idorder, any(revenue) AS r
  FROM default.udp_conversions FINAL
  WHERE idsite = ${idsite} AND server_date BETWEEN '${window0}' AND '${window1}'
  GROUP BY idvisit, idorder
),
hv AS (
  SELECT DISTINCT v.cid AS cid
  FROM o JOIN v ON toInt64(v.idvisit) = toInt64(o.idvisit)
  WHERE o.r >= ${hv} AND v.cid != ''
),
pv AS (
  SELECT DISTINCT v.cid AS cid, pages.url AS page_url, pages.pc AS page_pc
  FROM default.udp_hsrce_pageviews AS p
  LEFT JOIN pages USING idsitehsr
  JOIN v ON toInt64(v.idvisit) = toInt64(p.idvisit)
  WHERE p.idsite = ${idsite} AND p.server_date BETWEEN '${window0}' AND '${window1}' AND v.cid != ''
)
SELECT page_url AS url, page_pc AS pc,
  uniqExact(cid) AS visitors,
  uniqExactIf(cid, cid IN (SELECT cid FROM hv)) AS hv_visitors,
  (SELECT uniqExact(cid) FROM v WHERE cid != '') AS all_visitors_total,
  (SELECT count() FROM hv) AS hv_visitors_total
FROM pv
GROUP BY page_url, page_pc
HAVING visitors >= 100 OR hv_visitors >= 3
ORDER BY hv_visitors DESC, visitors DESC`;
}

const PIPE_SKIP = `('trigger-chains', 'dwell-model-inputs', 'audit-template', 'audit-funnel', 'descriptor-snapshot')`;

export function pipelineSql(site) {
  return `
SELECT dataset_id, bot_filter, toString(dim_week) AS dim_week, dim_device, dim_source, dim_returning,
  dim_selector, dim_element_class, dim_surface, dim_tool, dim_extra, metrics
FROM ${clickHouseDatabase(process.env)}.ae_dataset_row_current
WHERE idsite = ${site.idsite}
  AND dataset_id NOT IN ${PIPE_SKIP}
  AND (dataset_id != 'tap-geometry-weekly' OR JSONExtractFloat(metrics, 'clicks') >= 3)
  AND (dataset_id != 'render-snapshot' OR (JSONExtractFloat(metrics, 'w') > 0 AND JSONExtractFloat(metrics, 'h') > 0))
  AND (dataset_id != 'rage-clicks' OR JSONExtractFloat(metrics, 'rage_sessions') > 0)
  AND (
    bot_filter IN ('', 'exclude_confirmed', 'portal_11_4')
    OR (bot_filter = 'none' AND dataset_id NOT IN (
      SELECT DISTINCT dataset_id FROM ${clickHouseDatabase(process.env)}.ae_dataset_row_current
      WHERE idsite = ${site.idsite} AND bot_filter = 'exclude_confirmed'
    ))
  )`;
}

export function triggerSql(site) {
  return `
SELECT
  if(JSONHas(dim_extra, 'server_date'), JSONExtractString(dim_extra, 'server_date'), JSONExtractString(metrics, 'server_date')) AS server_date,
  if(JSONHas(dim_extra, 'trigger_key'), JSONExtractString(dim_extra, 'trigger_key'), JSONExtractString(metrics, 'trigger_key')) AS trigger_key,
  dim_device,
  if(JSONHas(metrics, 'level'), JSONExtractString(metrics, 'level'), JSONExtractString(dim_extra, 'level')) AS level,
  toUInt8(if(JSONHas(metrics, 'final'), JSONExtractBool(metrics, 'final'), JSONExtractBool(dim_extra, 'final'))) AS final,
  count() AS chains,
  sum(JSONExtractUInt(metrics, 'returned')) AS returned,
  sum(JSONExtractUInt(metrics, 'purchased')) AS purchased,
  sum(JSONExtractUInt(metrics, 'recovered')) AS recovered,
  sum(JSONExtractFloat(metrics, 'revenue')) AS revenue
FROM ${clickHouseDatabase(process.env)}.ae_dataset_row_current
WHERE idsite = ${site.idsite} AND dataset_id = 'trigger-chains'
  AND bot_filter IN ('', 'exclude_confirmed', 'portal_11_4', 'none')
GROUP BY server_date, trigger_key, dim_device, level, final`;
}

export function dwellSql(site) {
  return `
SELECT toString(dim_week) AS dim_week, dim_device,
  count() AS sessions,
  countIf(JSONExtractFloat(metrics, 'orders') > 0) AS sessions_with_order,
  sum(JSONExtractFloat(metrics, 'revenue')) AS revenue,
  quantile(0.5)(JSONExtractFloat(metrics, 'total_engaged_ms')) AS median_engaged_ms,
  quantile(0.75)(JSONExtractFloat(metrics, 'total_engaged_ms')) AS p75_engaged_ms
FROM ${clickHouseDatabase(process.env)}.ae_dataset_row_current
WHERE idsite = ${site.idsite} AND dataset_id = 'dwell-model-inputs'
  AND bot_filter IN ('', 'exclude_confirmed', 'portal_11_4', 'none')
GROUP BY dim_week, dim_device`;
}

export function rageTotalsSql(site) {
  return `
SELECT toString(dim_week) AS dim_week, dim_device, dim_element_class,
  sum(JSONExtractFloat(metrics, 'clicking_sessions')) AS clicking_sessions,
  sum(JSONExtractFloat(metrics, 'rage_sessions')) AS rage_sessions
FROM ${clickHouseDatabase(process.env)}.ae_dataset_row_current
WHERE idsite = ${site.idsite} AND dataset_id = 'rage-clicks'
  AND bot_filter IN ('', 'exclude_confirmed', 'portal_11_4', 'none')
GROUP BY dim_week, dim_device, dim_element_class`;
}

async function query(ch, sql) {
  const res = await ch.query({ query: sql, format: 'JSONEachRow' });
  return res.json();
}

async function streamVisits(ch, sql, file, append = false) {
  const res = await ch.query({ query: sql, format: 'JSONEachRow' });
  const out = fs.createWriteStream(file, { flags: append ? 'a' : 'w' });
  let n = 0;
  for await (const rows of res.stream()) {
    for (const row of rows) {
      out.write(row.text + '\n');
      n += 1;
      if (n % 200000 === 0) console.log('  visits', n);
    }
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  return n;
}

function writeJson(file, rows) {
  fs.writeFileSync(file, JSON.stringify(rows));
  console.log(' ', path.basename(file), rows.length);
}

async function exportSite(ch, site, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const mark = (label) => console.log(`${site.slug} ${label} ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const resume = process.env.BUNDLE_RESUME === '1' && fs.existsSync(path.join(dir, 'orders.json'));
  const refreshPages = process.env.BUNDLE_REFRESH_PAGES === '1';
  console.log(`${site.slug} orders`);
  const orders = repairOrderTitles(resume ? JSON.parse(fs.readFileSync(path.join(dir, 'orders.json'), 'utf8')) : await query(ch, ordersSql(site)));
  if (!resume) writeJson(path.join(dir, 'orders.json'), orders);
  mark(resume ? 'orders reused' : 'orders done');

  const inWindow = orders.filter((r) => r.d >= site.window0 && r.d <= site.window1).map((r) => Number(r.rev)).sort((a, b) => a - b);
  const p90 = inWindow.length ? inWindow[Math.min(inWindow.length - 1, Math.floor(inWindow.length * 0.9))] : 0;
  const hv = Math.max(10, Math.round(p90 / 10) * 10);
  const meta = {
    ...site,
    preStart: addDays(site.window0, -14),
    firstEnd: addDays(site.window0, 14),
    histStart: addDays(site.window0, -44),
    orderStart: addDays(site.window0, -30),
    orderEnd: site.window1,
    hv,
    p90,
    generated_utc: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(`${site.slug} high-value line ${hv} (p90 ${p90})`);

  if (!resume || refreshPages) {
    console.log(`${site.slug} page_period`);
    writeJson(path.join(dir, 'page_period.json'), await query(ch, pagePeriodSql(site)));
    mark('page_period done');
    console.log(`${site.slug} high value pages`);
    writeJson(path.join(dir, 'hv_page_reach.json'), await query(ch, hvSql(site, hv)));
    mark('hv done');
  }
  if (!resume) {
    console.log(`${site.slug} pipeline`);
    const pipeFile = path.join(dir, 'pipeline.jsonl');
    const nPipe = await streamVisits(ch, pipelineSql(site), pipeFile);
    console.log('  pipeline rows', nPipe);
    writeJson(path.join(dir, 'trigger_chains.json'), await query(ch, triggerSql(site)));
    writeJson(path.join(dir, 'dwell.json'), await query(ch, dwellSql(site)));
    writeJson(path.join(dir, 'rage_totals.json'), await query(ch, rageTotalsSql(site)));
    mark('pipeline done');
  } else if (!refreshPages) {
    console.log(`${site.slug} reusing page, high-value and pipeline extracts`);
  } else {
    console.log(`${site.slug} reusing pipeline extracts`);
  }

  console.log(`${site.slug} visits`);
  const configuredShards = Number(process.env.BUNDLE_VISIT_SHARDS ?? 8);
  const visitShards = Number.isInteger(configuredShards) && configuredShards > 0 ? configuredShards : 8;
  let n = 0;
  for (let index = 0; index < visitShards; index += 1) {
    const rows = await streamVisits(
      ch,
      visitSql(site, { index, count: visitShards }),
      path.join(dir, 'visits.jsonl'),
      index > 0,
    );
    n += rows;
    console.log(`  visit shard ${index + 1}/${visitShards} ${rows}`);
  }
  console.log(`${site.slug} visits ${n}`);
  mark('visits done');
}

/**
 * `--site <site.json> --window-start <day> --window-end <day> --out <dir>`:
 * the site spec, the job window, and the stage workspace the extracts go to.
 */
export function exportRequest(argv) {
  const flags = parseFlags(argv);
  const sitePath = valueOf(flags, 'site');
  const out = valueOf(flags, 'out');
  if (!sitePath || !out) throw new Error('usage: node py/bundle-export.mjs --site <site.json> --window-start YYYY-MM-DD --window-end YYYY-MM-DD --out <dir>');
  const { windowStart, windowEnd } = windowFlags(flags, 'bundle-export');
  const site = JSON.parse(fs.readFileSync(sitePath, 'utf8'));
  return { spec: exportSpec(site, { start: windowStart, end: windowEnd }), out: path.resolve(out) };
}

async function main() {
  const { spec, out } = exportRequest(process.argv.slice(2));
  const channels = bundleChannels(await loadSegmentationRegistry(process.env), spec.idsite);
  const ch = client();
  try {
    await exportSite(ch, { ...spec, channels }, out);
  } finally {
    await ch.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
