/**
 * The query behind a shaped dataset: the trend's session CTEs keyed by the
 * request's period, the attributes it reads, and the segmentation fan-out,
 * grouped by period, (segment, value), and the attributes it keys by.
 * Every fact alias carries idsite and server_date, so the gateway's
 * `shape:` bound check passes.
 */

import { foldCondition, sqlVisitor } from '../domain/segmentation/conditions.js';
import { visitAttributeSql } from '../domain/shaping/attributes.js';
import { periodSql } from '../domain/shaping/period.js';
import { groupParts, segmentedSelect } from './segmentation-sql.js';
import { TREND_COLUMNS, measureJoins, sessionCtes, templateSql, urlPathSql } from './trend-sql.js';

/** The most cells one query may return; the query asks for one more, to know it overflowed. */
export const MAX_CELLS = 50_000;

/**
 * What the data-quality dispositions of a build drop. `orders` and
 * `visits` say whether the {qualityOrders} and {qualityVisits} parameters
 * are bound; each condition reads attributes the query computes, and
 * drops the sessions it holds.
 * @typedef {{orders: boolean, visits: boolean, conditions: ReadonlyArray<object>}} QualityExclusions
 */
export const NO_EXCLUSIONS = Object.freeze({ orders: false, visits: false, conditions: Object.freeze([]) });

export const SHAPE_SETTINGS = `
SETTINGS max_execution_time = 300,
         max_bytes_before_external_group_by = 2147483648,
         timeout_before_checking_execution_speed = 0`;

/**
 * An entry attribute's expression over `e`. The landing page reads
 * (unknown) when the session has no recorded page; a later step reads
 * (unknown) then too, and (exit) when the session left before it.
 * @param {'template' | 'path' | 'page'} property
 * @param {number} step
 */
function entrySql(property, step) {
  const url = step === 1 ? 'e.entry_url' : `e.step${step}_url`;
  const page = step === 1 ? 'e.entry_page' : `e.step${step}_page`;
  if (property === 'page') return `toInt64(${page})`;
  const value = property === 'template' ? templateSql(url) : urlPathSql(url);
  if (step === 1) return property === 'template' ? `if(${url} = '', '(unknown)', ${value})` : value;
  return `multiIf(e.entry_page = 0, '(unknown)', ${page} = 0, '(exit)', ${value})`;
}

/**
 * Where each attribute is in the shaped query: a field in the trend column
 * map, a visit attribute in its own visits column, an entry attribute over
 * the session's first pages `e`. Every expression is non-null.
 * @param {ReadonlyArray<import('../domain/shaping/attributes.js').Attribute>} attributes the ones the query computes
 * @returns {Record<string, string>}
 */
export function shapeColumns(attributes) {
  const columns = {};
  for (const attr of attributes) {
    if (attr.kind === 'field') columns[attr.id] = TREND_COLUMNS[attr.id];
    else if (attr.kind === 'visit') columns[attr.id] = `k.attr_${attr.id}`;
    else if (attr.kind === 'entry') columns[attr.id] = entrySql(attr.property, attr.step ?? 1);
    else throw new Error(`attribute ${attr.id} is a ${attr.kind}; the query does not compute it`);
  }
  return columns;
}

/**
 * The session's first three recorded pages in the period, in (server_time,
 * idloghsr) order, with consecutive views of one page as one step: each
 * step's URL and page id, '' and 0 past the last.
 */
function entryCtes(period) {
  const step = (n, name) => `steps[${n}].4 AS ${name}_url, steps[${n}].3 AS ${name}_page`;
  return `,
entry_pages AS (
    SELECT toUInt64(idsitehsr) AS idsitehsr, any(screenshot_url) AS url
    FROM default.site_hsr
    WHERE idsite = {idsite:UInt32}
    GROUP BY idsitehsr
),
entry_views AS (
    SELECT CAST(h.idvisit AS UInt64) AS idvisit,
           ${period('h.server_date')} AS week,
           arraySort(groupArray(tuple(toUnixTimestamp(h.server_time), toUInt64(h.idloghsr), toUInt64(h.idsitehsr), p.url))) AS views
    FROM default.udp_hsrce_pageviews AS h
    INNER JOIN entry_pages AS p ON p.idsitehsr = toUInt64(h.idsitehsr)
    WHERE h.idsite = {idsite:UInt32}
      AND h.server_date BETWEEN {w0:Date} AND {w1:Date}
    GROUP BY idvisit, week
),
entry AS (
    SELECT idvisit, week,
           arrayFilter((v, i) -> i = 1 OR v.3 != views[greatest(i - 1, 1)].3, views, arrayEnumerate(views)) AS steps,
           ${step(1, 'entry')},
           ${step(2, 'step2')},
           ${step(3, 'step3')}
    FROM entry_views
)`;
}

/**
 * One query group of a shaped dataset.
 * @param {object} spec
 * @param {ReadonlyArray<import('../domain/shaping/attributes.js').Attribute>} spec.attributes every attribute the query computes:
 *   the keys, the filter's fields, and the segmentations' fields
 * @param {string[]} spec.queryKeys the attributes the cells are grouped by, aliased a_<id>
 * @param {object | null} spec.filter a condition over spec.attributes
 * @param {import('../domain/shaping/period.js').PeriodSpec} spec.period
 * @param {QualityExclusions} [spec.exclusions] what data-quality dispositions drop
 * @param {import('./segmentation-sql.js').QueryGroup} group
 */
export function shapeSql({ attributes, queryKeys, filter, period, exclusions = NO_EXCLUSIONS }, group) {
  const columns = shapeColumns(attributes);
  const parts = groupParts(group, {});
  const needs = new Set([...attributes.flatMap((attr) => attr.needs), ...group.segmentations.flatMap((seg) => seg.needs)]);
  const ragers = parts.ragers || needs.has('ragers');
  const entry = needs.has('entry');
  const periodOf = (dateExpr) => periodSql(dateExpr, period);
  const extra = attributes.filter((attr) => attr.kind === 'visit').map((attr) => `${visitAttributeSql(attr)} AS attr_${attr.id}`);
  const where = [
    ...(filter ? [foldCondition(filter, sqlVisitor(columns, 'filter'))] : []),
    ...(exclusions.visits ? ['toString(k.idvisit) NOT IN {qualityVisits:Array(String)}'] : []),
    ...exclusions.conditions.map((condition) => `NOT ${foldCondition(condition, sqlVisitor(columns, 'quality exclusion'))}`),
  ];
  return `
WITH
${sessionCtes({ ragers, period: periodOf, extra, excludeOrders: exclusions.orders })}${entry ? entryCtes(periodOf) : ''}${parts.ctes}
${segmentedSelect({
    group,
    columns,
    viewport: "'all'",
    keys: queryKeys.map((id) => [columns[id], `a_${id}`]),
    from: entry ? 'kept AS k\n    LEFT JOIN entry AS e ON e.idvisit = k.idvisit AND e.week = k.week' : 'kept AS k',
    joins: measureJoins({ ragers, joins: parts.joins }),
    ...(where.length > 0 ? { where: where.join('\n      AND ') } : {}),
  })}LIMIT {cellLimit:UInt32}
${SHAPE_SETTINGS}`;
}
