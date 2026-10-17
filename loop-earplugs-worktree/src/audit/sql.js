import { HSR_IN_LIMIT } from './bounds.js';
import { LABELS, pageClassSql, pathSql } from '../domain/page-class/index.js';

/**
 * SQL fragments for the Roswell audit reader.
 *
 * These queries use default.log_* (portal legacy / Talk to My Data), not the
 * landing-page udp_* spine. Bot exclusion is the portal predicate in the
 * ClickHouse data model §11.4, not the fingerprint flag in bot-flag.js.
 */

/** @param {string} [alias] visit alias, empty for an unqualified column */
export function botPredicate(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `${p}location_city != 'Social Circle'
    AND NOT (
      ${p}location_city IN (
        'Forest City', 'Prineville', 'Altoona', 'Fort Worth',
        'Huntsville', 'Eagle Mountain', 'Hillsboro', 'Ashburn'
      )
      AND ${p}referer_name = 'Facebook'
    )`;
}

/**
 * @param {string} alias
 * @param {string} [startParam]
 * @param {string} [endParam]
 */
export function datePredicate(alias, startParam = 'start', endParam = 'end') {
  return `${alias}.server_date BETWEEN {${startParam}:Date} AND {${endParam}:Date} AND ${alias}.server_date <= today()`;
}

/** Tablet reports with Desktop. Device code 3 is Mobile. */
export function deviceExpr(alias) {
  return `if(${alias}.config_device_type = 3, 'Mobile', 'Desktop')`;
}

/** referer_type codes from data model §11.3. */
export function channelExpr(alias) {
  return `multiIf(
      ${alias}.referer_type = 1, 'Direct',
      ${alias}.referer_type = 2, 'Search',
      ${alias}.referer_type = 3, 'Referral',
      ${alias}.referer_type = 6, 'Paid',
      ${alias}.referer_type = 7, 'Social',
      'Other')`;
}

export function returningExpr(alias) {
  return `if(${alias}.visitor_returning = 1, 'returning', 'new')`;
}

/**
 * Deduped visit revenue. FINAL, grouped by idvisit, dates on the fact table.
 * @param {string} [startParam]
 * @param {string} [endParam]
 */
export function conversionCte(startParam = 'start', endParam = 'end') {
  return `conv AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit,
           sum(revenue) AS revenue,
           count() AS orders
    FROM default.log_conversion FINAL
    WHERE idsite = {idsite:UInt32}
      AND server_date BETWEEN {${startParam}:Date} AND {${endParam}:Date}
      AND server_date <= today()
    GROUP BY idvisit
)`;
}

/**
 * The Shopify preset with the template labels (pageClassSql), with brand
 * rules as bound match() branches in front. SQL twin of classifyTemplate.
 * @param {string} urlExpr
 * @param {Array<{pattern: string, template: string}>} [rules]
 */
export function templateMultiIf(urlExpr, rules = []) {
  const path = pathSql(urlExpr);
  const before = rules.flatMap((_, i) => [`match(${path}, concat('(?i)', {rule${i}:String}))`, `{tpl${i}:String}`]);
  return pageClassSql(urlExpr, { labels: LABELS.template, before });
}

/** @param {Array<{pattern: string, template: string}>} rules */
export function templateRuleParams(rules = []) {
  /** @type {Record<string, string>} */
  const params = {};
  rules.forEach((rule, i) => {
    params[`rule${i}`] = rule.pattern;
    params[`tpl${i}`] = rule.template;
  });
  return params;
}

/** Portal scroll: fold floor, 0–1000 scale. Divide by 10 for percent. */
export function scrollUnitsExpr(alias) {
  const scroll = `ifNull(${alias}.scroll_y_max_relative, 0)`;
  const fold = `ifNull(${alias}.fold_y_relative, 0)`;
  return `if(${scroll} > ${fold}, ${scroll}, ${fold})`;
}

/** Milliseconds above 5 seconds, expressed in seconds. Null otherwise. */
export function timeOnPageSecondsExpr(alias) {
  return `if(${alias}.time_on_page > 5000, ${alias}.time_on_page / 1000, NULL)`;
}

/**
 * idsitehsr predicate. null means the page set is unknown. An empty list
 * means the template has no pages. Sets above HSR_IN_LIMIT are omitted:
 * they do not prune, and splitting them would double-count visits.
 * @param {string} alias
 * @param {number[]|null|undefined} ids
 * @param {string} [param]
 */
export function hsrClauseSql(alias, ids, param = 'hsr') {
  if (!Array.isArray(ids)) return '';
  if (ids.length === 0) return 'AND 1 = 0';
  if (ids.length > HSR_IN_LIMIT) return '';
  return `AND ${alias}.idsitehsr IN {${param}:Array(UInt32)}`;
}

/** @param {number[]|null|undefined} ids @param {string} [param] */
export function hsrParams(ids, param = 'hsr') {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > HSR_IN_LIMIT) return {};
  return { [param]: ids };
}

/**
 * site_hsr URL lookup. Template classification is applied by the caller
 * with templateMultiIf on `p.url`.
 * @param {number[]|null} [hsrIds]
 */
export function pagesCte(hsrIds = null) {
  let hsr = '';
  if (Array.isArray(hsrIds)) {
    hsr = hsrIds.length === 0 || hsrIds.length > HSR_IN_LIMIT
      ? (hsrIds.length === 0 ? 'AND 1 = 0' : '')
      : 'AND idsitehsr IN {hsr:Array(UInt32)}';
  }
  return `pages AS (
    SELECT idsitehsr, any(screenshot_url) AS url
      FROM default.site_hsr
     WHERE idsite = {idsite:UInt32}
       ${hsr}
     GROUP BY idsitehsr
  )`;
}

/**
 * log_hsr joined to the classified page and the visit, with the bot
 * predicate on the visit. `h` and `v` and `p` are the aliases.
 * @param {Array<{pattern: string, template: string}>} [rules]
 * @param {number[]|null} [hsrIds]
 */
export function pageviewJoin(rules = [], hsrIds = null) {
  const from = `FROM default.log_hsr AS h
            INNER JOIN pages AS p ON p.idsitehsr = h.idsitehsr
            INNER JOIN default.log_visit AS v
              ON v.idsite = {idsite:UInt32} AND v.idsite = h.idsite AND CAST(v.idvisit AS UInt64) = CAST(h.idvisit AS UInt64)
             AND ${datePredicate('v')}`;
  const where = `h.idsite = {idsite:UInt32}
             AND ${datePredicate('h')}
             ${hsrClauseSql('h', hsrIds)}
             AND ${botPredicate('v')}`;
  return {
    template: templateMultiIf('p.url', rules),
    from,
    where,
    sql: `${from}
           WHERE ${where}`,
    params: { ...templateRuleParams(rules), ...hsrParams(hsrIds) },
  };
}

/**
 * Click joined to its pageview, the visit, and the naming matrix.
 * The caller supplies the element_matrix CTE. Extra joins go between
 * clickFrom() and clickWhere().
 */
export function clickFrom() {
  return `FROM default.log_hsr_event AS e
            INNER JOIN default.log_hsr AS h
              ON h.idsite = e.idsite AND h.idsitehsr = e.idsitehsr
             AND h.server_date = e.server_date
             AND h.idvisit = e.idvisit AND h.idloghsr = e.idloghsr
            INNER JOIN element_matrix AS m
              ON m.idsite = e.idsite AND match(e.selector, m.selector_match)
             AND e.server_date BETWEEN m.valid_from AND m.valid_to
            INNER JOIN default.log_visit AS v
              ON v.idsite = {idsite:UInt32} AND v.idsite = e.idsite AND CAST(v.idvisit AS UInt64) = CAST(e.idvisit AS UInt64)
             AND ${datePredicate('v')}`;
}

/** Predicates for clickFrom(). @param {number[]|null} [hsrIds] */
export function clickWhere(hsrIds = null) {
  return `e.idsite = {idsite:UInt32}
             AND ${datePredicate('e')}
             ${hsrClauseSql('e', hsrIds)}
             AND h.idsite = {idsite:UInt32}
             AND ${datePredicate('h')}
             ${hsrClauseSql('h', hsrIds)}
             AND e.event_type = 2
             AND ${botPredicate('v')}`;
}

/** clickFrom() plus its WHERE. @param {number[]|null} [hsrIds] */
export function clickJoin(hsrIds = null) {
  return `${clickFrom(hsrIds)}
           WHERE ${clickWhere(hsrIds)}`;
}

/**
 * Session-level audit SQL must carry the site parameter, a date bound, and
 * the portal bot predicate. Returns the missing pieces.
 * @param {string} sql
 */
export function sessionSqlGaps(sql) {
  /** @type {string[]} */
  const gaps = [];
  if (!sql.includes('{idsite:')) gaps.push('idsite');
  if (!sql.includes('server_date')) gaps.push('server_date');
  if (!sql.includes("location_city != 'Social Circle'")) gaps.push('bot');
  return gaps;
}
