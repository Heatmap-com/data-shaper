/**
 * Experiment scans. Every fact alias carries idsite and server_date, so the
 * gateway's `experiment:` bound check passes.
 *
 * udp_partner_tags has idvisit and idloghsr swapped: its idloghsr column is
 * the visit id every other udp table joins on, and its idvisit column is the
 * pageview id. Read the visit from pt.idloghsr only.
 *
 * A tag is written on a pageview where the partner script assigned the
 * visit, not only on the page under test, so the tag scan is never bound to
 * a page. Exposure to the page under test comes from the visit's pageviews.
 */

import { UTM_COLUMNS, sessionUtmSql, tagUtmCte } from '../adapters/_lib/sql.js';
import { botPredicate } from '../audit/sql.js';
import { segmentTuplesSql } from '../enrichment/segmentation-sql.js';
import { TREND_COLUMNS, VIEWPORT_EXPR, templateSql } from '../enrichment/trend-sql.js';

/** Where each segmentation field is in the experiment fact query. Its aliases are the trend's: `k`, `o`, `ck`, `r`. */
export const EXPERIMENT_COLUMNS = TREND_COLUMNS;

export const SETTINGS = `
SETTINGS max_execution_time = 300,
         max_bytes_before_external_group_by = 2147483648,
         timeout_before_checking_execution_speed = 0`;

/** One row per (day, partner, experience, raw variant, friendly name) with distinct visits. */
export function tagDaysSql() {
  return `
SELECT toString(pt.server_date) AS day,
       pt.partner AS partner,
       pt.experience_id AS experience_id,
       pt.variant_id AS variant_id,
       pt.friendly_name AS friendly_name,
       uniqExact(pt.idloghsr) AS visits
FROM default.udp_partner_tags AS pt
WHERE pt.idsite = {idsite:UInt32}
  AND pt.server_date BETWEEN {s0:Date} AND {s1:Date}
GROUP BY day, partner, experience_id, variant_id, friendly_name
LIMIT 200000
${SETTINGS}`;
}

/**
 * Tag counts per (partner, experience, raw variant, page) with the page's
 * template, over the scan. The surface inference reads which templates
 * every arm fires on.
 */
export function tagSurfaceSql() {
  return `
SELECT pt.partner AS partner,
       pt.experience_id AS experience_id,
       pt.variant_id AS variant_id,
       toString(pt.idsitehsr) AS idsitehsr,
       any(${templateSql('hp.url')}) AS template,
       count() AS tags
FROM default.udp_partner_tags AS pt
LEFT JOIN (
    SELECT toUInt64(s.idsitehsr) AS idsitehsr, any(s.screenshot_url) AS url
    FROM default.site_hsr AS s
    WHERE s.idsite = {idsite:UInt32}
    GROUP BY idsitehsr
) AS hp ON hp.idsitehsr = toUInt64(pt.idsitehsr)
WHERE pt.idsite = {idsite:UInt32}
  AND pt.server_date BETWEEN {s0:Date} AND {s1:Date}
GROUP BY partner, experience_id, variant_id, idsitehsr
LIMIT 500000
${SETTINGS}`;
}

/** The partner registry the tag scripts reported, latest row per experiment. */
export function registrySql() {
  return `
SELECT ifNull(l.partner, '') AS partner,
       ifNull(l.experiment_id, '') AS experiment_id,
       argMax(ifNull(l.experiment_name, ''), l.last_recorded) AS experiment_name,
       argMax(ifNull(l.variations, ''), l.last_recorded) AS variations,
       groupUniqArray(ifNull(l.variant_id, '')) AS variant_ids,
       toString(min(l.created_at)) AS first_seen,
       toString(max(l.last_recorded)) AS last_seen
FROM default.partner_tags_logs AS l
WHERE l.idsite = {idsite:UInt32}
GROUP BY partner, experiment_id
LIMIT 5000`;
}

/**
 * Visits kept after the portal bot predicate, restricted to assigned visits.
 * @param {string} assignedVisits subquery returning idvisit
 */
function visitCtes(assignedVisits, { ragers = false } = {}) {
  const kept = botPredicate('v').replaceAll('v.location_city', 'city').replaceAll('v.referer_name', 'referer_name');
  return `${tagUtmCte('visit_tags', {
    keys: [['idvisit', 'CAST(idvisit AS UInt64)']],
    from: '{d0:Date}',
    to: '{d1:Date}',
    and: ` AND CAST(idvisit AS UInt64) IN (${assignedVisits})`,
  })},
visit_rows AS (
    SELECT CAST(v.idvisit AS UInt64) AS idvisit,
           toUInt8(argMin(v.config_device_type, v.visit_first_action_time)) AS device,
           toInt32(ifNull(argMin(v.referer_type, v.visit_first_action_time), 0)) AS referer_type,
           toUInt8(ifNull(argMin(v.visitor_returning, v.visit_first_action_time), false)) AS returning,
           ifNull(lower(trim(toString(argMin(v.custom_var_k5, v.visit_first_action_time)))), '') AS utm_source,
           ifNull(lower(trim(toString(argMin(v.custom_var_v1, v.visit_first_action_time)))), '') AS utm_medium,
           ifNull(trim(toString(argMin(v.custom_var_v4, v.visit_first_action_time))), '') AS utm_campaign,
           ifNull(trim(toString(argMin(v.location_country, v.visit_first_action_time))), '') AS country,
           trim(toString(argMin(v.location_city, v.visit_first_action_time))) AS city,
           trim(toString(argMin(v.referer_name, v.visit_first_action_time))) AS referer_name,
           ifNull(lower(referer_name), '') AS referer_name_lc
    FROM default.udp_hsrce_visits AS v
    WHERE v.idsite = {idsite:UInt32}
      AND v.server_date BETWEEN {d0:Date} AND {d1:Date}
      AND CAST(v.idvisit AS UInt64) IN (${assignedVisits})
    GROUP BY idvisit
),
visits AS (
    SELECT r.* REPLACE (${UTM_COLUMNS.map((key) => `${sessionUtmSql(key, 't', `r.${key}`)} AS ${key}`).join(', ')})
    FROM visit_rows AS r
    LEFT JOIN visit_tags AS t ON t.idvisit = r.idvisit
),
kept AS (
    SELECT * FROM visits
    WHERE ${kept}
),
orders AS (
    SELECT CAST(cv.idvisit AS UInt64) AS idvisit,
           uniqExact(cv.idorder) AS orders,
           sum(cv.order_revenue) AS revenue
    FROM (
        SELECT uc.idvisit AS idvisit, uc.idorder AS idorder, any(uc.revenue) AS order_revenue
        FROM default.udp_conversions AS uc
        WHERE uc.idsite = {idsite:UInt32}
          AND uc.server_date BETWEEN {d0:Date} AND {d1:Date}
        GROUP BY uc.idvisit, uc.idorder
    ) AS cv
    GROUP BY idvisit
),
checkout AS (
    SELECT CAST(j.idvisit AS UInt64) AS idvisit
    FROM default.journey_events_map AS j
    WHERE j.idsite = {idsite:UInt32}
      AND j.server_date BETWEEN {d0:Date} AND {d1:Date}
      AND j.event_type = 'checkout_started'
    GROUP BY idvisit
)${ragers ? `,
ragers AS (
    SELECT CAST(rc.idvisit AS UInt64) AS idvisit
    FROM default.udp_clicksce_clicks AS rc
    WHERE rc.idsite = {idsite:UInt32}
      AND rc.server_date BETWEEN {d0:Date} AND {d1:Date}
      AND rc.meta1 = 'rage'
    GROUP BY idvisit
)` : ''}`;
}

/**
 * Assigned visits: one row per (visit, experiment) with the arm, the first
 * assignment day, and how many arms of that experiment the visit was in.
 * `raw` maps `partner|experience_id|variant_id` to `{exp}:{arm}` indexes.
 * Only tags on the experiment's surface count: an experiment index in
 * `surfaceAll`, or a `{exp}|{idsitehsr}` pair in `surfacePages`. Off the
 * surface a partner tags every visit as control, whatever its arm.
 * The day must fall in the experiment's active period.
 */
function assignedCtes() {
  return `
tag_cells AS (
    SELECT toUInt64(pt.idloghsr) AS idvisit,
           transform(concat(pt.partner, '|', pt.experience_id, '|', pt.variant_id), {raw:Array(String)}, {mapped:Array(String)}, '') AS cell,
           toUInt32(splitByChar(':', cell)[1]) AS cell_exp,
           toString(pt.idsitehsr) AS tag_page,
           pt.server_date AS day
    FROM default.udp_partner_tags AS pt
    WHERE pt.idsite = {idsite:UInt32}
      AND pt.server_date BETWEEN {d0:Date} AND {d1:Date}
      AND concat(pt.partner, '|', pt.experience_id, '|', pt.variant_id) IN {raw:Array(String)}
),
tags AS (
    SELECT idvisit, cell, min(day) AS day
    FROM tag_cells
    WHERE has({surfaceAll:Array(UInt32)}, cell_exp)
       OR has({surfacePages:Array(String)}, concat(toString(cell_exp), '|', tag_page))
    GROUP BY idvisit, cell
),
assigned AS (
    SELECT idvisit,
           toUInt32(splitByChar(':', cell)[1]) AS exp,
           any(toUInt32(splitByChar(':', cell)[2])) AS arm,
           uniqExact(splitByChar(':', cell)[2]) AS arms_seen,
           min(day) AS day
    FROM tags
    GROUP BY idvisit, exp
),
clean AS (
    SELECT * FROM assigned
    WHERE day BETWEEN arrayElement({starts:Array(Date)}, exp + 1) AND arrayElement({ends:Array(Date)}, exp + 1)
)`;
}

/**
 * Pages each assigned visit viewed, with their template. Needed only when
 * some experiment exposes by template or page.
 */
function viewedCte() {
  return `
hsr_pages AS (
    SELECT toUInt64(s.idsitehsr) AS idsitehsr, any(s.screenshot_url) AS url
    FROM default.site_hsr AS s
    WHERE s.idsite = {idsite:UInt32}
    GROUP BY idsitehsr
),
viewed AS (
    SELECT CAST(h.idvisit AS UInt64) AS idvisit,
           groupUniqArray(${templateSql('p.url')}) AS templates,
           groupUniqArray(toUInt64(h.idsitehsr)) AS pages
    FROM default.udp_hsrce_pageviews AS h
    LEFT JOIN hsr_pages AS p ON p.idsitehsr = toUInt64(h.idsitehsr)
    WHERE h.idsite = {idsite:UInt32}
      AND h.server_date BETWEEN {d0:Date} AND {d1:Date}
      AND CAST(h.idvisit AS UInt64) IN (SELECT idvisit FROM clean)
    GROUP BY idvisit
)`;
}

const EXPOSED = `(
    arrayExists(t -> has({expo:Array(String)}, concat(toString(c.exp), '|t:', t)), pv.templates)
 OR arrayExists(pg -> has({expo:Array(String)}, concat(toString(c.exp), '|p:', toString(pg))), pv.pages))`;

// Per-visit outcome columns for the inner SELECT. The arrayJoin fan-out
// reads ungrouped columns, so it runs in a subquery and SUMS aggregates it.
const VISIT_OUTCOMES = `
       ifNull(o.orders, 0) AS v_orders,
       ifNull(o.revenue, 0) AS v_revenue,
       ck.idvisit = k.idvisit AS v_progressed`;

const SUMS = `
       count() AS sessions,
       countIf(v_orders > 0) AS buyers,
       sum(v_orders) AS orders,
       sum(v_revenue) AS revenue,
       sum(pow(v_revenue, 2)) AS revenue_sq,
       countIf(v_progressed) AS progressed`;

/**
 * Experiment-level rows: one per (experiment, arm, basis, day, viewport,
 * segment, segment value). A visit in two arms of one experiment is
 * counted once, under basis `multi_arm` and arm 0, and nowhere else.
 * @param {{withViewed: boolean, segmentations: ReadonlyArray<import('../ports/segmentation.js').Segmentation>}} opts
 */
export function experimentFactSql({ withViewed, segmentations }) {
  if (!segmentations?.length) throw new Error('experimentFactSql needs the segmentations to read');
  const exposed = withViewed ? EXPOSED : '0';
  const ragers = segmentations.some((seg) => seg.needs.includes('ragers'));
  return `
WITH
${assignedCtes()},
${visitCtes('SELECT idvisit FROM clean', { ragers })}${withViewed ? `,${viewedCte()}` : ''}
SELECT exp, arm_index, day, basis, viewport_type, segment, segment_value,
       ${SUMS}
FROM (
SELECT c.exp AS exp,
       if(c.arms_seen > 1, 0, c.arm) AS arm_index,
       toString(c.day) AS day,
       arrayJoin(multiIf(c.arms_seen > 1, ['multi_arm'], ${exposed}, ['assigned', 'exposed'], ['assigned'])) AS basis,
       arrayJoin(if(c.arms_seen > 1, ['all'], ['all', ${VIEWPORT_EXPR}])) AS viewport_type,
       arrayJoin(if(c.arms_seen > 1,
         [tuple('all', 'all')],
         ${segmentTuplesSql(segmentations, EXPERIMENT_COLUMNS, { withAll: true })})) AS seg,
       tupleElement(seg, 1) AS segment,
       tupleElement(seg, 2) AS segment_value,
       ${VISIT_OUTCOMES}
FROM clean AS c
INNER JOIN kept AS k ON k.idvisit = c.idvisit
LEFT JOIN orders AS o ON o.idvisit = c.idvisit
LEFT JOIN checkout AS ck ON ck.idvisit = c.idvisit
${ragers ? 'LEFT JOIN ragers AS r ON r.idvisit = c.idvisit' : ''}
${withViewed ? 'LEFT JOIN viewed AS pv ON pv.idvisit = c.idvisit' : ''}
)
GROUP BY exp, arm_index, day, basis, viewport_type, segment, segment_value
${SETTINGS}`;
}

/**
 * Page rows: assigned visits that viewed one of the operator's pages under
 * test, per (experiment, arm, page, day, viewport). `pagePairs` holds
 * `{exp}|{idsitehsr}`.
 */
export function pageFactSql() {
  return `
WITH
${assignedCtes()},
${visitCtes('SELECT idvisit FROM clean')},
on_page AS (
    SELECT CAST(h.idvisit AS UInt64) AS idvisit,
           toUInt64(h.idsitehsr) AS idsitehsr
    FROM default.udp_hsrce_pageviews AS h
    WHERE h.idsite = {idsite:UInt32}
      AND h.server_date BETWEEN {d0:Date} AND {d1:Date}
      AND toUInt64(h.idsitehsr) IN {pages:Array(UInt64)}
      AND CAST(h.idvisit AS UInt64) IN (SELECT idvisit FROM clean)
    GROUP BY idvisit, idsitehsr
)
SELECT exp, arm_index, day, idsitehsr, viewport_type,
       ${SUMS}
FROM (
SELECT c.exp AS exp,
       c.arm AS arm_index,
       toString(c.day) AS day,
       toString(pg.idsitehsr) AS idsitehsr,
       arrayJoin(['all', ${VIEWPORT_EXPR}]) AS viewport_type,
       ${VISIT_OUTCOMES}
FROM clean AS c
INNER JOIN on_page AS pg ON pg.idvisit = c.idvisit
INNER JOIN kept AS k ON k.idvisit = c.idvisit
LEFT JOIN orders AS o ON o.idvisit = c.idvisit
LEFT JOIN checkout AS ck ON ck.idvisit = c.idvisit
WHERE c.arms_seen = 1
  AND has({pagePairs:Array(String)}, concat(toString(c.exp), '|', toString(pg.idsitehsr)))
)
GROUP BY exp, arm_index, day, idsitehsr, viewport_type
${SETTINGS}`;
}

/**
 * Shopify writes the theme's template and section-group ids into section
 * ids (`shopify-section-template--20045246103645__hero`). They change on
 * every theme publish and differ between the arms of a theme test, so
 * selectors are keyed without them.
 * @param {string} column
 */
export function normalizedSelectorSql(column) {
  return `replaceRegexpAll(${column}, '${String.raw`(template|sections)--\\d+__`}', '${String.raw`\\1--__`}')`;
}

// Pages an experiment's sections and elements are read on: every page for
// an index in zoneAll, else the `{exp}|{idsitehsr}` pairs in zonePages.
// zonePageIds / zoneAnyPage prefilter the scan to those pages.
const ON_ZONE_PAGE = (page) => `(has({zoneAll:Array(UInt32)}, c.exp) OR has({zonePages:Array(String)}, concat(toString(c.exp), '|', ${page})))`;
const ZONE_PAGE_SCAN = (column) => `({zoneAnyPage:UInt8} = 1 OR has({zonePageIds:Array(UInt64)}, toUInt64(${column})))`;

/**
 * Rollup rows from section_level_data, per (experiment, arm, section, basis,
 * day, viewport). The section tracker captures a sample of visits, so
 * `section_captured` (section '') counts the arm's visits with any section
 * event on the experiment's pages: the base every section rate divides by.
 * `section_seen` / `section_clicked` are the visits that saw (the tracker's
 * visible-and-dwelled event) or clicked inside the section. Each
 * experiment keeps its operator zones (`zonePairs`, `{exp}|{section}`) and
 * at most sectionCap more sections with at least sectionMin visits.
 */
export function sectionFactSql() {
  return `
WITH
${assignedCtes()},
${visitCtes('SELECT idvisit FROM clean')},
sec AS (
    SELECT s.idvisit AS idvisit,
           toString(s.idsitehsr) AS page,
           s.section_name AS section,
           any(s.section_path) AS path,
           max(s.event_type = 'scroll') AS seen,
           max(s.event_type = 'click') AS clicked
    FROM default.section_level_data AS s
    WHERE s.idsite = {idsite:UInt32}
      AND s.server_date BETWEEN {d0:Date} AND {d1:Date}
      AND ${ZONE_PAGE_SCAN('s.idsitehsr')}
      AND s.section_name != ''
      AND s.idvisit IN (SELECT idvisit FROM clean)
    GROUP BY idvisit, page, section
),
vsec AS (
    SELECT c.idvisit AS idvisit, c.exp AS exp, c.arm AS arm, c.day AS day,
           sc.section AS section, any(sc.path) AS path,
           max(sc.seen) AS seen, max(sc.clicked) AS clicked
    FROM clean AS c
    INNER JOIN sec AS sc ON sc.idvisit = c.idvisit
    WHERE c.arms_seen = 1
      AND ${ON_ZONE_PAGE('sc.page')}
    GROUP BY idvisit, exp, arm, day, section
),
picked AS (
    SELECT exp, section
    FROM vsec
    GROUP BY exp, section
    HAVING uniqExact(idvisit) >= {sectionMin:UInt32}
        OR has({zonePairs:Array(String)}, concat(toString(exp), '|', section))
    ORDER BY has({zonePairs:Array(String)}, concat(toString(exp), '|', section)) DESC, uniqExact(idvisit) DESC
    LIMIT {sectionCap:UInt32} BY exp
),
units AS (
    SELECT idvisit, exp, arm, day, '' AS unit_section, '' AS unit_path, ['section_captured'] AS bases
    FROM vsec
    GROUP BY idvisit, exp, arm, day
    UNION ALL
    SELECT idvisit, exp, arm, day, section AS unit_section, path AS unit_path,
           arrayFilter(b -> b != '', [if(seen = 1, 'section_seen', ''), if(clicked = 1, 'section_clicked', '')]) AS bases
    FROM vsec
    WHERE (exp, section) IN (SELECT exp, section FROM picked)
)
SELECT exp, arm_index, day, section, any(v_path) AS section_path, basis, viewport_type,
       ${SUMS}
FROM (
SELECT u.exp AS exp,
       u.arm AS arm_index,
       toString(u.day) AS day,
       u.unit_section AS section,
       u.unit_path AS v_path,
       arrayJoin(u.bases) AS basis,
       arrayJoin(['all', ${VIEWPORT_EXPR}]) AS viewport_type,
       ${VISIT_OUTCOMES}
FROM units AS u
INNER JOIN kept AS k ON k.idvisit = u.idvisit
LEFT JOIN orders AS o ON o.idvisit = u.idvisit
LEFT JOIN checkout AS ck ON ck.idvisit = u.idvisit
)
GROUP BY exp, arm_index, day, section, basis, viewport_type
${SETTINGS}`;
}

/**
 * Element rows from every click on the experiment's pages, per
 * (experiment, arm, selector, day, viewport). sessions is the clicking
 * visits. Each experiment keeps its operator elements (`elementPairs`,
 * `{exp}|{normalized selector}`) and at most elementCap more selectors with
 * at least elementMin clicking visits. section is the innermost rollup
 * section the selector was clicked in most often, '' when the section
 * tracker never saw it inside one or the site has no section table.
 * @param {{withSections?: boolean}} [opts]
 */
export function elementFactSql({ withSections = true } = {}) {
  const inSection = withSections
    ? `,
in_section AS (
    SELECT selector,
           argMax(tuple(section, path), n) AS best,
           tupleElement(best, 1) AS el_section,
           tupleElement(best, 2) AS el_path
    FROM (
        SELECT ${normalizedSelectorSql('s.element_selector')} AS selector,
               s.section_name AS section,
               s.section_path AS path,
               count() AS n
        FROM default.section_level_data AS s
        WHERE s.idsite = {idsite:UInt32}
          AND s.server_date BETWEEN {d0:Date} AND {d1:Date}
          AND ${ZONE_PAGE_SCAN('s.idsitehsr')}
          AND s.event_type = 'click'
          AND s.section_name != ''
        GROUP BY selector, section, path
    )
    GROUP BY selector
)`
    : '';
  return `
WITH
${assignedCtes()},
${visitCtes('SELECT idvisit FROM clean')},
el_clicks AS (
    SELECT CAST(cl.idvisit AS UInt64) AS idvisit,
           toString(cl.idsitehsr) AS page,
           ${normalizedSelectorSql('cl.idselector')} AS selector,
           count() AS clicks
    FROM default.udp_clicksce_clicks AS cl
    WHERE cl.idsite = {idsite:UInt32}
      AND cl.server_date BETWEEN {d0:Date} AND {d1:Date}
      AND ${ZONE_PAGE_SCAN('cl.idsitehsr')}
      AND CAST(cl.idvisit AS UInt64) IN (SELECT idvisit FROM clean)
    GROUP BY idvisit, page, selector
),
vel AS (
    SELECT c.idvisit AS idvisit, c.exp AS exp, c.arm AS arm, c.day AS day,
           e.selector AS selector, sum(e.clicks) AS clicks
    FROM clean AS c
    INNER JOIN el_clicks AS e ON e.idvisit = c.idvisit
    WHERE c.arms_seen = 1
      AND ${ON_ZONE_PAGE('e.page')}
    GROUP BY idvisit, exp, arm, day, selector
),
picked AS (
    SELECT exp, selector
    FROM vel
    GROUP BY exp, selector
    HAVING uniqExact(idvisit) >= {elementMin:UInt32}
        OR has({elementPairs:Array(String)}, concat(toString(exp), '|', selector))
    ORDER BY has({elementPairs:Array(String)}, concat(toString(exp), '|', selector)) DESC, uniqExact(idvisit) DESC
    LIMIT {elementCap:UInt32} BY exp
)${inSection}
SELECT exp, arm_index, day, selector, section, section_path, viewport_type,
       sum(v_clicks) AS clicks,
       ${SUMS}
FROM (
SELECT v.exp AS exp,
       v.arm AS arm_index,
       toString(v.day) AS day,
       v.selector AS selector,
       ${withSections ? 'm.el_section' : "''"} AS section,
       ${withSections ? 'm.el_path' : "''"} AS section_path,
       arrayJoin(['all', ${VIEWPORT_EXPR}]) AS viewport_type,
       v.clicks AS v_clicks,
       ${VISIT_OUTCOMES}
FROM vel AS v
INNER JOIN kept AS k ON k.idvisit = v.idvisit
LEFT JOIN orders AS o ON o.idvisit = v.idvisit
LEFT JOIN checkout AS ck ON ck.idvisit = v.idvisit
${withSections ? 'LEFT JOIN in_section AS m ON m.selector = v.selector' : ''}
WHERE (v.exp, v.selector) IN (SELECT exp, selector FROM picked)
)
GROUP BY exp, arm_index, day, selector, section, section_path, viewport_type
${SETTINGS}`;
}
