#!/usr/bin/env node
/**
 * Live acceptance of the segmentation registry (SG12), read only. Every
 * warehouse read goes through the read-only client, and every write goes to
 * memory persistence.
 *
 *   1. Parity. The site's stored `ae_trend_row_current` rows over the window,
 *      written by the code before the registry, are copied to memory so the
 *      run keeps the same subjects. The trend then runs with the default
 *      selection and its rows are compared with the stored ones on sessions,
 *      buyers, orders, clicks, progressed, and revenue to the cent. A
 *      segmented cell whose `all` cell also differs is late data; a cell
 *      that differs only in a segmentation is a fault.
 *   2. Cost. The default selection, then the default plus `channel` and
 *      `return_intent`, three runs each, on fresh memory seeded the same way.
 *      With --baseline-seconds (the old code's query seconds for the same
 *      run) it reports N4: default at most 1.25 times, wide under 2 times.
 *   3. Override. --segmentation-check of a Google-paid override of `channel`
 *      on the last complete week, or of --override-file.
 *
 *   node scripts/segmentation-acceptance.mjs --idsite <idsite> [--window-start 2026-09-14 --window-end 2026-10-09]
 *     [--runs 3] [--baseline-seconds <s>] [--override-file <path>] [--skip parity,cost,override] [--out <dir>]
 *
 * The report is written to <out>/<idsite>.json, under segmentation-acceptance
 * in the OS temp dir by default. Exits 1 when parity finds a fault or the
 * override check fails.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { createClickHouseAePersistence } from '../src/adapters/persistence/clickhouse.js';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import { createGateway } from '../src/adapters/query-gateway/clickhouse.js';
import { segmentationCheck } from '../src/application/commands/segmentation-check.js';
import { clickHouseConfig, clickHouseDatabase, createClickHouseClient } from '../src/composition/clickhouse.js';
import { loadSegmentationSpecs, loadTrendSeeds, orchestrationRoot } from '../src/composition/registries.js';
import { loadSegmentationRegistry } from '../src/composition/segmentations.js';
import { runTrend } from '../src/enrichment/trend-run.js';
import { lastWholeSunday } from '../src/enrichment/trend-window.js';
import { addDays } from '../src/triggers/time.js';
import { acceptanceGateway, readOnlyClient, rowsOf } from './lib/read-only-warehouse.mjs';

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const next = argv[i + 1];
    flags[arg.slice(2)] = next && !next.startsWith('--') ? (i += 1, next) : 'true';
  }
  return flags;
}

const COUNTS = ['sessions', 'buyers', 'orders', 'clicks', 'progressed'];
const WIDE = ['channel', 'return_intent'];
const GOOGLE_PAID = {
  value: 'google_paid',
  when: { all: [{ field: 'source_or_referrer', like: '%google%' }, { field: 'utm_medium', in: ['cpc', 'ppc', 'paid', 'paid_search'] }] },
};

const cell = (row) => [row.rowType, row.rowKey, row.rowKey1, row.rowKey2, row.idsitehsr ?? 0, row.viewportType, row.week].join('|');
const identity = (row) => `${cell(row)}|${row.segment}|${row.segmentValue}`;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value) => Math.round(value * 10) / 10;
const ratio = (value) => Math.round(value * 100) / 100;

/** The stored rows over the window, in the shape the stores write. */
async function storedRows(client, database, idsite, w0, w1) {
  const rows = await rowsOf(client, `
SELECT batch_id, idsite, idsitehsr, row_type, row_key, row_key_1, row_key_2, segment, segment_value,
       viewport_type, toString(week) AS week_text, sessions, buyers, orders, revenue, clicks, progressed, metrics
FROM ${database}.ae_trend_row_current
WHERE idsite = {idsite:UInt32} AND week BETWEEN {w0:Date} AND {w1:Date}`, { idsite, w0, w1 });
  return rows.map((r) => ({
    batchId: r.batch_id,
    idsite: Number(r.idsite),
    idsitehsr: Number(r.idsitehsr),
    rowType: r.row_type,
    rowKey: r.row_key,
    rowKey1: r.row_key_1,
    rowKey2: r.row_key_2,
    segment: r.segment,
    segmentValue: r.segment_value,
    viewportType: r.viewport_type,
    week: r.week_text,
    sessions: Number(r.sessions),
    buyers: Number(r.buyers),
    orders: Number(r.orders),
    revenue: Number(r.revenue),
    clicks: Number(r.clicks),
    progressed: Number(r.progressed),
    metrics: JSON.parse(r.metrics || '{}'),
  }));
}

/** Memory persistence holding the stored rows and selectors, that keeps the run's own writes. */
async function seededMemory(stored, selectors) {
  const memory = createMemoryAePersistence().adapter;
  if (stored.length > 0) await memory.writeTrendRows(stored);
  if (selectors.length > 0) await memory.writeTrendSelectors(selectors);
  const writes = [];
  return {
    writes,
    persistence: {
      ...memory,
      async writeTrendRows(rows) {
        writes.push(...rows);
        return memory.writeTrendRows(rows);
      },
    },
  };
}

const differs = (a, b) => COUNTS.some((m) => Number(a[m] ?? 0) !== Number(b[m] ?? 0)) || Math.abs(Number(a.revenue ?? 0) - Number(b.revenue ?? 0)) > 0.01;

/** The run's rows against the stored ones. */
function parity(stored, fresh) {
  const before = new Map(stored.map((row) => [identity(row), row]));
  const after = new Map(fresh.map((row) => [identity(row), row]));
  const allDiffers = new Set();
  for (const [key, row] of after) {
    if (row.segment !== 'all') continue;
    const prior = before.get(key);
    if (!prior || differs(prior, row)) allDiffers.add(cell(row));
  }
  const late = [];
  const faults = [];
  for (const [key, row] of after) {
    if (row.segment === 'all') continue;
    const prior = before.get(key);
    if (prior && !differs(prior, row)) continue;
    const entry = { identity: key, stored: prior ? [...COUNTS, 'revenue'].map((m) => prior[m]) : null, fresh: [...COUNTS, 'revenue'].map((m) => row[m]) };
    (allDiffers.has(cell(row)) ? late : faults).push(entry);
  }
  const missing = [...before.keys()].filter((key) => !after.has(key));
  return {
    storedRows: before.size,
    freshRows: after.size,
    allCellsDiffering: allDiffers.size,
    lateData: { count: late.length, sample: late.slice(0, 10) },
    faults: { count: faults.length, sample: faults.slice(0, 20) },
    missingFromRun: { count: missing.length, sample: missing.slice(0, 10) },
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const idsite = Number(flags.idsite);
  if (!Number.isInteger(idsite) || idsite <= 0) throw new Error('--idsite is required');
  const windowStart = flags['window-start'] ?? '2026-09-14';
  const windowEnd = flags['window-end'] ?? '2026-10-09';
  const runs = Math.max(1, Number(flags.runs ?? 3));
  const baseline = flags['baseline-seconds'] ? Number(flags['baseline-seconds']) : null;
  const skip = new Set(String(flags.skip ?? '').split(',').filter(Boolean));
  const today = new Date().toISOString().slice(0, 10);
  const out = flags.out ?? path.join(os.tmpdir(), 'segmentation-acceptance');
  mkdirSync(out, { recursive: true });
  const logger = pino({ level: 'info' }, pino.destination({ dest: path.join(out, `${idsite}.log`), sync: false }));
  const say = (text) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${text}\n`);

  const env = process.env;
  const database = clickHouseDatabase(env);
  const raw = createClickHouseClient(clickHouseConfig(env));
  const client = readOnlyClient(raw);
  const live = createClickHouseAePersistence({ client, database, logger }).adapter;
  const gateway = acceptanceGateway(createGateway(client, { logger, database }), client);
  const registry = await loadSegmentationRegistry(env);
  const report = { idsite, window: { windowStart, windowEnd }, started: new Date().toISOString() };
  const write = () => writeFileSync(path.join(out, `${idsite}.json`), `${JSON.stringify(report, null, 2)}\n`);
  let failed = false;

  try {
    const stored = skip.has('parity') && skip.has('cost') ? [] : await storedRows(client, database, idsite, windowStart, windowEnd);
    const selectors = await live.readTrendSelectors(idsite);
    const seeds = selectors.length > 0 ? [] : await loadTrendSeeds(orchestrationRoot(env));
    say(`${stored.length} stored rows, ${selectors.length} stored selector pages`);

    const trendRun = async (segmentations) => {
      const { writes, persistence } = await seededMemory(stored, selectors);
      const from = gateway.calls.length;
      const started = Date.now();
      const result = await runTrend({ idsite, windowStart, windowEnd, seeds, segmentations, gateway, persistence, logger });
      const calls = gateway.calls.slice(from);
      return { result, writes, wall: (Date.now() - started) / 1000, querySeconds: calls.reduce((sum, call) => sum + call.seconds, 0), queries: calls.length };
    };

    const variants = {
      default: registry.select(idsite, 'trend'),
      wide: registry.select(idsite, 'trend', [...registry.defaults(idsite, 'trend'), ...WIDE.filter((id) => !registry.defaults(idsite, 'trend').includes(id))]),
    };
    const timings = { default: [], wide: [] };

    if (!skip.has('parity')) {
      say('parity: default selection');
      const run = await trendRun(variants.default);
      timings.default.push(run);
      report.parity = { check: run.result.check?.ok ?? null, ...parity(stored, run.writes) };
      write();
      say(`parity: ${report.parity.freshRows} rows against ${report.parity.storedRows} stored, ${report.parity.faults.count} faults, ${report.parity.lateData.count} late-data cells`);
      if (report.parity.faults.count > 0) failed = true;
    }

    if (!skip.has('cost')) {
      for (const name of ['default', 'wide']) {
        while (timings[name].length < runs) {
          say(`cost: ${name} run ${timings[name].length + 1} of ${runs}`);
          timings[name].push(await trendRun(variants[name]));
        }
      }
      const summary = (list, ids) => ({
        segmentations: ids.map((seg) => seg.id),
        wall: list.map((run) => round(run.wall)),
        querySeconds: list.map((run) => round(run.querySeconds)),
        median: round(median(list.map((run) => run.querySeconds))),
        queries: list[0].queries,
        rows: list[0].result.rows,
      });
      report.cost = { default: summary(timings.default, variants.default), wide: summary(timings.wide, variants.wide) };
      report.cost.wideOverDefault = ratio(report.cost.wide.median / report.cost.default.median);
      if (baseline) {
        const def = report.cost.default.median / baseline;
        const wide = report.cost.wide.median / baseline;
        report.cost.n4 = { baselineSeconds: baseline, default: ratio(def), wide: ratio(wide), ok: def <= 1.25 && wide < 2 };
      }
      write();
      say(`cost: default median ${report.cost.default.median}s, wide ${report.cost.wide.median}s${report.cost.n4 ? `, N4 ${report.cost.n4.ok ? 'met' : 'missed'}` : ''}`);
    }

    if (!skip.has('override')) {
      const week = addDays(lastWholeSunday(today), -6);
      let file = flags['override-file'];
      if (!file) {
        file = path.join(out, `${idsite}-google-paid.json`);
        writeFileSync(file, `${JSON.stringify({ idsite, overrides: { channel: { prepend: [GOOGLE_PAID] } } }, null, 2)}\n`);
      }
      say(`override: --segmentation-check on the week of ${week}, ${file}`);
      const ctx = {
        segmentations: async () => registry,
        segmentationsWith: (site) => loadSegmentationRegistry(env, undefined, { site }),
        registries: { segmentations: () => loadSegmentationSpecs(orchestrationRoot(env)) },
        gateway: () => gateway,
        persistence: () => live,
      };
      const result = await segmentationCheck.run({ 'segmentation-check': 'true', sites: String(idsite), week, 'segmentation-file': file }, ctx);
      report.override = { week, file, ok: result.ok, exitCode: result.ok ? 0 : result.exitCode ?? 1, output: result.output, errors: result.errors ?? [] };
      write();
      if (result.output) process.stdout.write(`${result.output}\n`);
      for (const error of result.errors ?? []) process.stdout.write(`  ${error}\n`);
      if (!result.ok) failed = true;
    }
  } finally {
    report.finished = new Date().toISOString();
    write();
    await raw.close();
  }
  say(`report: ${path.join(out, `${idsite}.json`)}`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
});
