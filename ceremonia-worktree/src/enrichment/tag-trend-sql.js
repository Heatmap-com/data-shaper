/**
 * Site-scoped session-tag scans. A tag value is the visit's first value
 * for that key, by idloghsr, lowercased and cut to 128 characters. Keys
 * are lowercased too, so `UTM_Source` and `utm_source` are one key.
 */

import { groupParts, segmentedSelect } from './segmentation-sql.js';
import { TREND_COLUMNS, VIEWPORT_EXPR, sessionCtes } from './trend-sql.js';

/** Separates key and value in the selected-pair list. The SQL side is char(1). */
export const PAIR_SEPARATOR = '\u0001';

/**
 * @param {boolean} filtered keep only keys in {tagKeys}
 */
function tagValuesCte(filtered) {
  return `
tag_values AS (
    SELECT idvisit, tag_key, argMin(raw_value, idloghsr) AS tag_value
    FROM (
        SELECT CAST(idvisit AS UInt64) AS idvisit,
               idloghsr,
               lower(kv.1) AS tag_key,
               lower(substring(trim(BOTH '"' FROM kv.2), 1, 128)) AS raw_value
        FROM default.udp_session_tags
        ARRAY JOIN JSONExtractKeysAndValuesRaw(session_tags) AS kv
        WHERE idsite = {idsite:UInt32}
          AND server_date BETWEEN {w0:Date} AND {w1:Date}
          AND session_tags NOT IN ('{}', '')
          ${filtered ? 'AND lower(kv.1) IN {tagKeys:Array(String)}' : ''}
    )
    WHERE raw_value NOT IN ('', 'null')
    GROUP BY idvisit, tag_key
)`;
}

/** Every key with its tagged visits and distinct values. No bot filter. */
export function tagInventorySql() {
  return `
WITH
${tagValuesCte(false)}
SELECT tag_key, uniqExact(idvisit) AS visits, uniqExact(tag_value) AS distinct_values
FROM tag_values
GROUP BY tag_key
ORDER BY visits DESC, tag_key
`;
}

/**
 * Window totals per (key, value) over kept sessions, plus one `total` row
 * for every kept session. A session is a visit in one week, as the weekly
 * rows count it. The squared sums feed the spread tests.
 */
export function tagValueStatsSql() {
  return `
WITH
${sessionCtes()},
${tagValuesCte(true)}
SELECT 'value' AS kind,
       t.tag_key AS tag_key,
       t.tag_value AS tag_value,
       uniqExact(k.idvisit, k.week) AS sessions,
       uniqExactIf(k.idvisit, k.week, ifNull(o.orders, 0) > 0) AS buyers,
       sum(ifNull(o.orders, 0)) AS orders,
       sum(ifNull(o.revenue, 0)) AS revenue,
       sum(ifNull(o.revenue, 0) * ifNull(o.revenue, 0)) AS visit_revenue_sq,
       sum(ifNull(o.order_revenue_sq, 0)) AS order_revenue_sq
FROM kept AS k
INNER JOIN tag_values AS t ON t.idvisit = k.idvisit
LEFT JOIN orders AS o ON o.idvisit = k.idvisit AND o.week = k.week
GROUP BY t.tag_key, t.tag_value
UNION ALL
SELECT 'total' AS kind,
       '' AS tag_key,
       '' AS tag_value,
       uniqExact(k.idvisit, k.week) AS sessions,
       uniqExactIf(k.idvisit, k.week, ifNull(o.orders, 0) > 0) AS buyers,
       sum(ifNull(o.orders, 0)) AS orders,
       sum(ifNull(o.revenue, 0)) AS revenue,
       sum(ifNull(o.revenue, 0) * ifNull(o.revenue, 0)) AS visit_revenue_sq,
       sum(ifNull(o.order_revenue_sq, 0)) AS order_revenue_sq
FROM kept AS k
LEFT JOIN orders AS o ON o.idvisit = k.idvisit AND o.week = k.week
`;
}

/**
 * Every kept session once per selected key. A visit without the key is
 * `(none)`. A value outside the selected pairs is `other`.
 * @param {import('./segmentation-sql.js').QueryGroup} group
 * @param {object} [inputs] the run inputs computed segmentations read
 */
export function tagTrendAggregateSql(group, inputs = {}) {
  const parts = groupParts(group, inputs);
  const joins = [
    'LEFT JOIN tag_values AS t ON t.idvisit = k.idvisit AND t.tag_key = sk.tag_key',
    'LEFT JOIN orders AS o ON o.idvisit = k.idvisit AND o.week = k.week',
    'LEFT JOIN checkout AS ck ON ck.idvisit = k.idvisit AND ck.week = k.week',
    ...(parts.ragers ? ['LEFT JOIN ragers AS r ON r.idvisit = k.idvisit AND r.week = k.week'] : []),
    ...(parts.joins ? [parts.joins] : []),
  ];
  return `
WITH
${sessionCtes(parts)},
${tagValuesCte(true)}${parts.ctes},
selected_keys AS (
    SELECT arrayJoin({tagKeys:Array(String)}) AS tag_key
)
${segmentedSelect({
    group,
    columns: TREND_COLUMNS,
    viewport: VIEWPORT_EXPR,
    keys: [
      ['sk.tag_key', 'key_value'],
      [`multiIf(
             t.tag_value = '', '(none)',
             has({tagPairs:Array(String)}, concat(sk.tag_key, char(1), t.tag_value)), t.tag_value,
             'other')`, 'trend_value'],
    ],
    from: 'kept AS k\n    CROSS JOIN selected_keys AS sk',
    joins: joins.join('\n    '),
  })}`;
}
