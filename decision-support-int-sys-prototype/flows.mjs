#!/usr/bin/env node
// Journeys and funnel for the query tool, read only. Journeys are the trend run's own rows with a path
// limit of 5, written to memory. The funnel reuses the trend's session CTEs and segmented select.
//
//   node prototype/query-tool/flows.mjs --site mellow     (merges into an existing snapshot)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { clickHouseConfig, clickHouseDatabase, createClickHouseClient } from '../../src/composition/clickhouse.js';
import { loadSegmentationRegistry } from '../../src/composition/segmentations.js';
import { createGateway } from '../../src/adapters/query-gateway/clickhouse.js';
import { createMemoryAePersistence } from '../../src/adapters/persistence/memory.js';
import { runTrend } from '../../src/enrichment/trend-run.js';
import { measureJoins, sessionCtes, templateSql, TREND_COLUMNS, VIEWPORT_EXPR } from '../../src/enrichment/trend-sql.js';
import { groupParams, groupParts, planGroups, segmentedSelect } from '../../src/enrichment/segmentation-sql.js';
import { runInputs } from '../../src/enrichment/segmentation-inputs.js';
import { addDays } from '../../src/triggers/time.js';
import { acceptanceGateway, readOnlyClient } from '../../scripts/lib/read-only-warehouse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const DEVICES = ['desktop', 'tablet', 'mobile'];
const SETTINGS = `
SETTINGS max_execution_time = 600,
         max_bytes_before_external_group_by = 2147483648,
         timeout_before_checking_execution_speed = 0`;

function funnelSql(group, inputs) {
  const parts = groupParts(group, inputs);
  return `
WITH
${sessionCtes(parts)},
hsr_pages AS (
    SELECT toUInt64(idsitehsr) AS idsitehsr, any(screenshot_url) AS url
    FROM default.site_hsr
    WHERE idsite = {idsite:UInt32}
    GROUP BY idsitehsr
),
entries AS (
    SELECT CAST(h.idvisit AS UInt64) AS idvisit,
           toMonday(h.server_date) AS week,
           argMin(${templateSql('p.url')}, (toUnixTimestamp(h.server_time), toUInt64(h.idloghsr))) AS entry
    FROM default.udp_hsrce_pageviews AS h
    INNER JOIN hsr_pages AS p ON p.idsitehsr = toUInt64(h.idsitehsr)
    WHERE h.idsite = {idsite:UInt32}
      AND h.server_date BETWEEN {w0:Date} AND {w1:Date}
    GROUP BY idvisit, week
),
steps AS (
    SELECT CAST(idvisit AS UInt64) AS idvisit,
           toMonday(server_date) AS week,
           max(event_type = 'product_viewed') AS pv,
           max(event_type = 'add_to_cart') AS atc
    FROM default.journey_events_map
    WHERE idsite = {idsite:UInt32}
      AND server_date BETWEEN {w0:Date} AND {w1:Date}
      AND event_type IN ('product_viewed', 'add_to_cart')
    GROUP BY idvisit, week
)${parts.ctes}
${segmentedSelect({
    group,
    columns: TREND_COLUMNS,
    viewport: VIEWPORT_EXPR,
    keys: [["ifNull(nullIf(e.entry, ''), '(no page view)')", 'entry']],
    from: 'kept AS k\n    LEFT JOIN entries AS e ON e.idvisit = k.idvisit AND e.week = k.week\n    LEFT JOIN steps AS st ON st.idvisit = k.idvisit AND st.week = k.week',
    joins: measureJoins(parts),
    extra: [
      ['ifNull(st.pv, 0)', 'v_pv', 'uniqExactIf(idvisit, v_pv > 0) AS product_viewed'],
      ['ifNull(st.atc, 0)', 'v_atc', 'uniqExactIf(idvisit, v_atc > 0) AS added_to_cart'],
    ],
  })}${SETTINGS}`;
}

const FUNNEL_MEASURES = ['sessions', 'product_viewed', 'added_to_cart', 'checkout_started', 'buyers', 'orders', 'revenue'];

// The query writes each device; `all` is their sum, with visits of unknown device counted only there.
function funnelTable(cells) {
  const out = new Map();
  for (const c of cells) {
    const viewports = DEVICES.includes(c.viewport_value) ? ['all', c.viewport_value] : ['all'];
    for (const viewport of viewports) {
      const key = [c.entry, viewport, c.segment, c.segment_value, c.week_start].join('|');
      const row = out.get(key) ?? { entry: c.entry, viewport_type: viewport, segment: c.segment, segment_value: c.segment_value, week: c.week_start, ...Object.fromEntries(FUNNEL_MEASURES.map((m) => [m, 0])) };
      row.sessions += Number(c.sessions);
      row.product_viewed += Number(c.product_viewed);
      row.added_to_cart += Number(c.added_to_cart);
      row.checkout_started += Number(c.progressed);
      row.buyers += Number(c.buyers);
      row.orders += Number(c.orders);
      row.revenue = Math.round((row.revenue + Number(c.revenue)) * 100) / 100;
      out.set(key, row);
    }
  }
  const columns = ['entry', 'viewport_type', 'segment', 'segment_value', 'week', ...FUNNEL_MEASURES];
  return { columns, rows: [...out.values()].map((r) => columns.map((c) => r[c])) };
}

function journeyTable(rows) {
  const columns = ['kind', 'row_key', 'path', 'step_index', 'step', 'rank', 'viewport_type', 'segment', 'segment_value', 'week',
    'sessions', 'buyers', 'orders', 'revenue', 'progressed'];
  const out = [];
  for (const r of rows) {
    if (r.rowType !== 'journey' || !['all', ...DEVICES].includes(r.viewportType)) continue;
    const isStep = r.rowKey === 'step' || r.rowKey === 'url_step';
    const kind = r.rowKey.startsWith('url_') ? 'page' : 'general';
    const cut = r.rowKey1.indexOf(':');
    const stepIndex = isStep ? Number(r.rowKey1.slice(0, cut)) : 0;
    const step = isStep ? r.rowKey1.slice(cut + 1) : '';
    const pathName = isStep ? r.rowKey2 : r.rowKey1;
    out.push([kind, isStep ? 'step' : 'path', pathName, stepIndex, step, Number(r.metrics?.rank ?? 0), r.viewportType, r.segment, r.segmentValue, r.week,
      r.sessions, r.buyers, r.orders, r.revenue, r.progressed]);
  }
  return { columns, rows: out };
}

/**
 * @param {{idsite: number, weeks: string[], pathLimit?: number, say?: (text: string) => void}} opts
 */
export async function pullFlows({ idsite, weeks, pathLimit = 5, say = console.log }) {
  if (!weeks.length) throw new Error('pullFlows needs the trend weeks');
  if (!process.env.CLICKHOUSE_HOST && fs.existsSync(path.join(repo, '.env'))) process.loadEnvFile(path.join(repo, '.env'));
  const env = process.env;
  const logger = pino({ level: 'silent' });
  const raw = createClickHouseClient(clickHouseConfig(env), { requestTimeoutMs: 900_000 });
  const client = readOnlyClient(raw);
  const gateway = acceptanceGateway(createGateway(client, { logger, database: clickHouseDatabase(env) }), client);
  const memory = createMemoryAePersistence().adapter;
  const written = [];
  const persistence = {
    ...memory,
    async writeTrendRows(rows) {
      for (const row of rows) written.push(row);
      return memory.writeTrendRows(rows);
    },
  };
  const windowStart = weeks[0];
  const windowEnd = addDays(weeks[weeks.length - 1], 6);
  try {
    const segmentations = (await loadSegmentationRegistry(env)).select(idsite, 'trend');
    say(`flows: journeys, top ${pathLimit} paths of each kind, ${windowStart} to ${windowEnd}`);
    let started = Date.now();
    const trend = await runTrend({ idsite, windowStart, windowEnd, pathLimit, rerank: true, seeds: [], segmentations, gateway, persistence, logger });
    say(`flows: journeys done in ${Math.round((Date.now() - started) / 1000)} s (${trend.paths.length} general, ${trend.urlPaths.length} page-specific)`);

    say('flows: funnel');
    started = Date.now();
    const inputs = await runInputs(segmentations, { persistence, idsite });
    const cells = [];
    for (const group of planGroups([...segmentations])) {
      const groupInputs = { ...inputs, start: windowStart };
      const rows = await gateway.query(funnelSql(group, groupInputs), { idsite, w0: windowStart, w1: windowEnd, ...groupParams(group, groupInputs) }, 'flows:funnel');
      for (const row of rows) cells.push(row);
    }
    say(`flows: funnel done in ${Math.round((Date.now() - started) / 1000)} s`);
    return {
      journeys: journeyTable(written),
      funnel: funnelTable(cells),
      summary: { window: { start: windowStart, end: windowEnd }, pathLimit, paths: trend.paths, urlPaths: trend.urlPaths, segmentations: segmentations.map((s) => s.id) },
    };
  } finally {
    await raw.close();
  }
}

// Standalone: merge into the site's existing snapshot.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--site');
  const slug = i > 0 ? process.argv[i + 1] : null;
  if (!slug) { console.error('--site <slug> is required'); process.exit(1); }
  const dir = path.join(here, 'data/sites', slug);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const { writeFlows } = await import('./snapshot.mjs');
  const flows = await pullFlows({ idsite: Number(manifest.site.idsite), weeks: manifest.warehouse.trendWeeks });
  writeFlows(dir, manifest, flows);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}
