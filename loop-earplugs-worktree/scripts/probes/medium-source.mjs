#!/usr/bin/env node
/**
 * Probe, read only: where a visit's UTM medium comes from. The analyst
 * bundle reads `custom_var_v1` at the visit's first action; the trigger
 * chains read the first session-tag key whose name contains `medium`. One
 * bounded query per site over one week compares the two per visit.
 *
 *   node scripts/probes/medium-source.mjs --sites <idsite,...> --week <Monday>
 *
 * Prints JSON: per site, visits by agreement class, and the ten most common
 * disagreeing (variable | tag) pairs.
 */
import { clickHouseConfig, createClickHouseClient } from '../../src/composition/clickhouse.js';
import { addDays } from '../../src/triggers/time.js';
import { readOnlyClient, rowsOf } from '../lib/read-only-warehouse.mjs';

const SQL = `
-- probe:medium-source
WITH
v AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit,
           lower(trim(ifNull(argMin(custom_var_v1, visit_first_action_time), ''))) AS var_medium
    FROM default.udp_hsrce_visits
    WHERE idsite = {idsite:UInt32}
      AND server_date BETWEEN {w0:Date} AND {w1:Date}
    GROUP BY idvisit
),
t AS (
    SELECT idvisit, argMin(raw_value, idloghsr) AS tag_medium
    FROM (
        SELECT CAST(idvisit AS UInt64) AS idvisit,
               idloghsr,
               lower(trim(BOTH '"' FROM kv.2)) AS raw_value
        FROM default.udp_session_tags
        ARRAY JOIN JSONExtractKeysAndValuesRaw(session_tags) AS kv
        WHERE idsite = {idsite:UInt32}
          AND server_date BETWEEN {w0:Date} AND {w1:Date}
          AND session_tags NOT IN ('{}', '')
          AND positionCaseInsensitive(kv.1, 'medium') > 0
    )
    WHERE raw_value NOT IN ('', 'null')
    GROUP BY idvisit
),
j AS (
    SELECT if(v.var_medium = 'null', '', v.var_medium) AS a, t.tag_medium AS b
    FROM v
    LEFT JOIN t ON t.idvisit = v.idvisit
)
SELECT multiIf(a = '' AND b = '', 'both_empty', b = '', 'only_variable', a = '', 'only_tag', a = b, 'both_equal', 'both_different') AS class,
       count() AS visits,
       topK(10)(concat(a, ' | ', b)) AS top_pairs
FROM j
GROUP BY class
ORDER BY class
SETTINGS max_execution_time = 300`;

/** Where the two disagree: which tag key carried the tag's value, and whether the visit has more than one medium tag. */
const KEYS_SQL = `
-- probe:medium-source-keys
WITH
v AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit,
           lower(trim(ifNull(argMin(custom_var_v1, visit_first_action_time), ''))) AS var_medium
    FROM default.udp_hsrce_visits
    WHERE idsite = {idsite:UInt32}
      AND server_date BETWEEN {w0:Date} AND {w1:Date}
    GROUP BY idvisit
),
t AS (
    SELECT idvisit,
           argMin(tag_key, idloghsr) AS first_key,
           argMin(raw_value, idloghsr) AS tag_medium,
           uniqExact(raw_value) AS tag_values
    FROM (
        SELECT CAST(s.idvisit AS UInt64) AS idvisit,
               s.idloghsr AS idloghsr,
               kv.1 AS tag_key,
               lower(trim(BOTH '"' FROM kv.2)) AS raw_value
        FROM default.udp_session_tags AS s
        ARRAY JOIN JSONExtractKeysAndValuesRaw(s.session_tags) AS kv
        WHERE s.idsite = {idsite:UInt32}
          AND s.server_date BETWEEN {w0:Date} AND {w1:Date}
          AND s.session_tags NOT IN ('{}', '')
          AND positionCaseInsensitive(kv.1, 'medium') > 0
    )
    WHERE raw_value NOT IN ('', 'null')
    GROUP BY idvisit
),
pairs AS (
    SELECT v.idvisit AS idvisit, v.var_medium AS a, t.tag_medium AS b, t.first_key AS first_key, t.tag_values AS tag_values
    FROM v
    INNER JOIN t ON t.idvisit = v.idvisit
    WHERE v.var_medium NOT IN ('', 'null') AND v.var_medium != t.tag_medium
)
SELECT first_key, tag_values > 1 AS several_tag_values, count() AS visits
FROM pairs
GROUP BY first_key, several_tag_values
ORDER BY visits DESC
LIMIT 20
SETTINGS max_execution_time = 300`;

function flag(name) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0 || !process.argv[at + 1]) throw new Error(`--${name} is required`);
  return process.argv[at + 1];
}

const sites = flag('sites').split(',').map(Number);
const w0 = flag('week');
const w1 = addDays(w0, 6);
const raw = createClickHouseClient(clickHouseConfig(process.env));
const client = readOnlyClient(raw);
const out = { run_at: new Date().toISOString(), week: { w0, w1 }, sites: {} };
try {
  for (const idsite of sites) {
    const started = Date.now();
    const rows = await rowsOf(client, SQL, { idsite, w0, w1 });
    out.sites[idsite] = {
      seconds: Math.round((Date.now() - started) / 100) / 10,
      classes: rows.map((row) => ({
        class: row.class,
        visits: Number(row.visits),
        topPairs: row.class === 'both_different' || row.class === 'only_tag' || row.class === 'only_variable' ? row.top_pairs : undefined,
      })),
      disagreeingKeys: (await rowsOf(client, KEYS_SQL, { idsite, w0, w1 })).map((row) => ({
        firstKey: row.first_key,
        severalTagValues: Number(row.several_tag_values) === 1,
        visits: Number(row.visits),
      })),
    };
  }
} finally {
  await raw.close();
}
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
