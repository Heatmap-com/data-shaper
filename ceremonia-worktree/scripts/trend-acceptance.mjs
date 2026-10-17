#!/usr/bin/env node
/**
 * Live check of the incremental trend, read only. One site's trend runs
 * twice on memory persistence over the live warehouse: first over whole
 * weeks ending the Sunday before last, then with `--next-weeks` over the
 * first run's store, then once over both runs' weeks on the same subjects.
 * The report gives the weeks and rows each run wrote and the rank queries
 * the second run issued. The store after the two runs (the first run's
 * weeks before the overlap, then the second run's) must equal the full
 * run on every week. The first run's last week can differ from both: a
 * visit that runs past its Sunday is cut at the window, and the overlap
 * week rewrites it.
 *
 *   node scripts/trend-acceptance.mjs --idsite <idsite> [--weeks 6] [--today YYYY-MM-DD] [--out <dir>]
 *
 * The output directory defaults to trend-acceptance under the OS temp dir.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { clickHouseConfig, clickHouseDatabase, createClickHouseClient } from '../src/composition/clickhouse.js';
import { loadTrendSeeds, orchestrationRoot } from '../src/composition/registries.js';
import { createGateway } from '../src/adapters/query-gateway/clickhouse.js';
import { createClickHouseAePersistence } from '../src/adapters/persistence/clickhouse.js';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import { runTrend } from '../src/enrichment/trend-run.js';
import { lastWholeSunday } from '../src/enrichment/trend-window.js';
import { addDays } from '../src/triggers/time.js';
import { acceptanceGateway, readOnlyClient } from './lib/read-only-warehouse.mjs';
import { loadSegmentationRegistry } from '../src/composition/segmentations.js';

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

const METRICS = ['sessions', 'buyers', 'orders', 'revenue', 'clicks', 'progressed'];
const identity = (row) => [row.rowKey, row.rowKey1, row.rowKey2, row.viewportType, row.segment, row.segmentValue, row.idsitehsr ?? 0].join('|');

/** Memory persistence that keeps each write's rows. */
function recording(persistence) {
  const writes = [];
  return {
    writes,
    persistence: {
      ...persistence,
      async writeTrendRows(rows) {
        writes.push(rows);
        return persistence.writeTrendRows(rows);
      },
    },
  };
}

/** One run's report: what it read, what it wrote, and its queries. */
function summary(result, rows, calls) {
  const byLabel = {};
  for (const call of calls) {
    const cell = byLabel[call.label] ?? { calls: 0, rows: 0, seconds: 0, w0: [] };
    cell.calls += 1;
    cell.rows += call.rows;
    cell.seconds = Math.round((cell.seconds + call.seconds) * 10) / 10;
    if (call.params.w0 && !cell.w0.includes(call.params.w0)) cell.w0.push(call.params.w0);
    byLabel[call.label] = cell;
  }
  const weeks = {};
  for (const row of rows) weeks[row.week] = (weeks[row.week] ?? 0) + 1;
  return {
    window: result.window,
    weeks: result.weeks,
    rowsByWeek: weeks,
    rows: result.rows,
    paths: result.paths,
    urlPaths: result.urlPaths,
    pages: result.pages.map((page) => page.idsitehsr),
    selectors: result.selectors,
    check: result.check,
    queries: byLabel,
  };
}

/** One week's rows of two runs, compared on every metric. */
function compareWeek(first, second, week) {
  const before = new Map(first.filter((row) => row.week === week).map((row) => [identity(row), row]));
  const after = second.filter((row) => row.week === week);
  const mismatches = [];
  let matched = 0;
  for (const row of after) {
    const prior = before.get(identity(row));
    const diff = prior ? METRICS.filter((m) => Number(prior[m] ?? 0) !== Number(row[m] ?? 0)) : ['missing in the first run'];
    if (diff.length === 0) matched += 1;
    else if (mismatches.length < 20) mismatches.push({ identity: identity(row), diff, first: prior ? METRICS.map((m) => prior[m]) : null, second: METRICS.map((m) => row[m]) });
  }
  const unmatched = [...before.keys()].filter((key) => !after.some((row) => identity(row) === key)).length;
  return { week, firstRows: before.size, secondRows: after.length, matched, mismatched: after.length - matched, onlyFirst: unmatched, mismatches };
}

/** The stored series (the first run's weeks before `overlap`, then the second run's) against the full run, week by week. */
function compareStore(first, second, full, overlap) {
  const stored = [...first.filter((row) => row.week < overlap), ...second];
  const weeks = [...new Set([...stored, ...full].map((row) => row.week))].sort();
  const byWeek = weeks.map((week) => compareWeek(full, stored, week));
  const equal = byWeek.every((cell) => cell.mismatched === 0 && cell.onlyFirst === 0 && cell.firstRows === cell.secondRows);
  return { equal, weeks: byWeek.map(({ mismatches, ...cell }) => (cell.mismatched ? { ...cell, mismatches: mismatches.slice(0, 5) } : cell)) };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const idsite = Number(flags.idsite);
  if (!Number.isInteger(idsite) || idsite <= 0) throw new Error('--idsite is required');
  const weekCount = Number(flags.weeks ?? 6);
  const today = flags.today ?? new Date().toISOString().slice(0, 10);
  const out = flags.out ?? path.join(os.tmpdir(), 'trend-acceptance');
  mkdirSync(out, { recursive: true });
  const logger = pino({ level: 'info' }, pino.destination({ dest: path.join(out, `${idsite}.log`), sync: false }));
  const say = (text) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${text}\n`);

  const env = process.env;
  const database = clickHouseDatabase(env);
  const raw = createClickHouseClient(clickHouseConfig(env));
  const client = readOnlyClient(raw);
  const live = createClickHouseAePersistence({ client, database, logger }).adapter;
  const gateway = acceptanceGateway(createGateway(client, { logger, database }), client);
  const memory = createMemoryAePersistence().adapter;
  const { writes, persistence } = recording(memory);

  const liveSelectors = await live.readTrendSelectors(idsite);
  const seeds = liveSelectors.length > 0 ? [] : await loadTrendSeeds(orchestrationRoot(env));
  if (liveSelectors.length > 0) await memory.writeTrendSelectors(liveSelectors);

  const segmentations = (await loadSegmentationRegistry(env)).select(idsite, 'trend');
  const firstEnd = addDays(lastWholeSunday(today), -7);
  const firstStart = addDays(firstEnd, 1 - 7 * weekCount);
  const report = { idsite, today, selectors: liveSelectors.length > 0 ? 'live' : 'seeds', started: new Date().toISOString() };
  const write = () => writeFileSync(path.join(out, `${idsite}.json`), `${JSON.stringify(report, null, 2)}\n`);

  say(`first run ${firstStart} to ${firstEnd}`);
  let from = gateway.calls.length;
  const first = await runTrend({ idsite, windowStart: firstStart, windowEnd: firstEnd, seeds, segmentations, gateway, persistence, logger });
  report.first = summary(first, writes.at(-1) ?? [], gateway.calls.slice(from));
  write();
  say(`first: ${first.weeks.length} weeks, ${first.rows} rows`);

  say('second run --next-weeks');
  from = gateway.calls.length;
  const second = await runTrend({ idsite, nextWeeks: { today }, seeds, segmentations, gateway, persistence, logger });
  report.second = summary(second, writes.at(-1) ?? [], gateway.calls.slice(from));
  report.second.rankQueries = gateway.calls.slice(from).filter((call) => call.label.endsWith('-rank')).map((call) => call.label);
  const overlap = addDays(firstEnd, -6);
  report.overlap = compareWeek(writes[0] ?? [], writes[1] ?? [], overlap);
  write();
  say(`second: weeks ${second.weeks.join(', ')}, ${second.rows} rows, rank queries ${report.second.rankQueries.length}`);
  say(`overlap ${overlap}: ${report.overlap.matched} of ${report.overlap.secondRows} rows equal the first run's last week`);

  const fullEnd = lastWholeSunday(today);
  say(`full run ${firstStart} to ${fullEnd} on the same subjects`);
  from = gateway.calls.length;
  const full = await runTrend({ idsite, windowStart: firstStart, windowEnd: fullEnd, seeds, segmentations, gateway, persistence, logger });
  report.full = summary(full, writes.at(-1) ?? [], gateway.calls.slice(from));
  report.store = compareStore(writes[0] ?? [], writes[1] ?? [], writes[2] ?? [], overlap);
  report.finished = new Date().toISOString();
  write();
  const cells = report.store.weeks.map((cell) => `${cell.week} ${cell.matched}/${cell.firstRows}`).join(', ');
  say(`store against the full run: ${report.store.equal ? 'equal' : 'DIFFER'} (${cells})`);
  await raw.close();
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
});
