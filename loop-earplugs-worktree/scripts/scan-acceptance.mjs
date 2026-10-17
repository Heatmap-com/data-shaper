#!/usr/bin/env node
/**
 * Live acceptance for the day scan, read only. One site of a stored batch
 * runs through the site-analysis handlers on memory persistence, over the
 * same window, qualifier, and page selector. The warehouse is read through
 * a client that refuses every write and every system table, so nothing in
 * ClickHouse changes. The report compares the run with the stored batch.
 *
 *   node --max-old-space-size=8192 scripts/scan-acceptance.mjs \
 *     --idsite <idsite> --batch <batch_id> [--mode span|stored|run] \
 *     [--day-scan on|off] [--datasets id,id] [--out <dir>] \
 *     [--window-start YYYY-MM-DD --window-end YYYY-MM-DD] \
 *     [--day-store <dir>|clickhouse [--overlap-days 2]] [--tag <name>] [--triggers-out on]
 *
 * The output directory defaults to scan-acceptance under the OS temp dir.
 *
 * --window-start and --window-end run the batch's settings over another
 * window; the comparison with the stored batch is then left out. The
 * clock reads the window's last day as today. --day-store keeps the days
 * the scan reads in a local day store, so a later window replays the final
 * ones. --day-store clickhouse keeps them in the live `ae_scan_day`, and
 * that table is the only one the run writes. --tag names the output files, <idsite>-<tag>.*, and --triggers-out
 * writes every trigger hit and chain, last version by identity, to
 * <idsite>-<tag>-hits.jsonl and -chains.jsonl. scripts/compare-rows.mjs
 * compares two tagged runs by content.
 *
 * span: per-visit day span and the largest gap between a visit's days.
 * stored: the stored batch's targets, dataset row counts, and trigger counts.
 * run: the handlers, then the comparison. Writes <out>/<idsite>-<mode>.json.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { adaptersIn, discoverAdapterRoles, selectAdapter } from '../src/discover.js';
import { clickHouseConfig, clickHouseDatabase, createClickHouseClient } from '../src/composition/clickhouse.js';
import { createGateway } from '../src/adapters/query-gateway/clickhouse.js';
import { createClickHouseAePersistence } from '../src/adapters/persistence/clickhouse.js';
import { INSERT_CHUNK, chainFromCh } from '../src/adapters/persistence/clickhouse/support.js';
import { createMemoryAePersistence } from '../src/adapters/persistence/memory.js';
import { createLocalDayStore } from '../src/adapters/day-store/local.js';
import { createClickHouseDayStore } from '../src/adapters/day-store/clickhouse.js';
import { triggerIdentity } from '../src/adapters/persistence/memory/support.js';
import { dayStoreClient } from './lib/read-only-warehouse.mjs';
import { dayEvents, daySql, spreadVisitsSql } from '../src/scan/day-record.js';
import { collectDatasets, createSiteState, qualify } from '../src/site-analysis/handlers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const READ = /^(SELECT|WITH|DESCRIBE|DESC|EXISTS|EXPLAIN)\b/i;
const LEADING = /^(\s+|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/;

/**
 * The client every read goes through. Inserts, commands, and any statement
 * other than a read throw before they reach the server.
 * @param {object} raw
 */
function readOnlyClient(raw) {
  const refuse = (what) => {
    throw new Error(`read-only client refused ${what}`);
  };
  return {
    async query(args) {
      const sql = String(args.query ?? '');
      const head = sql.replace(LEADING, '');
      if (!READ.test(head)) refuse(`"${head.slice(0, 40)}"`);
      if (/\bsystem\./i.test(sql)) refuse('a system table read');
      return raw.query(args);
    },
    insert: async () => refuse('an insert'),
    command: async () => refuse('a command'),
    exec: async () => refuse('an exec'),
    close: async () => raw.close(),
  };
}

async function rowsOf(client, query, params = {}) {
  const res = await client.query({ query, query_params: params, format: 'JSONEachRow' });
  return res.json();
}

const TABLE_PROBE = /FROM\s+system\.tables\s+WHERE\s+database\s*=\s*'(\w+)'\s+AND\s+table\s*=\s*'(\w+)'/;

/**
 * The gateway the datasets see: the production gateway over the read-only
 * client, with the two system-table reads answered by DESCRIBE and EXISTS.
 * Every label's calls, rows, and seconds are counted.
 */
function acceptanceGateway(base, client) {
  /** @type {Map<string, {calls: number, rows: number, maxRows: number, seconds: number}>} */
  const labels = new Map();
  const columns = new Map();
  const note = (label, rows, started) => {
    const cell = labels.get(label) ?? { calls: 0, rows: 0, maxRows: 0, seconds: 0 };
    cell.calls += 1;
    cell.rows += rows;
    cell.maxRows = Math.max(cell.maxRows, rows);
    cell.seconds += (Date.now() - started) / 1000;
    labels.set(label, cell);
  };
  return {
    labels,
    async query(sql, params = {}, label = 'query') {
      const started = Date.now();
      const probe = TABLE_PROBE.exec(sql);
      const rows = probe
        ? [{ n: Number((await rowsOf(client, `EXISTS TABLE ${probe[1]}.${probe[2]}`))[0]?.result ?? 0) }]
        : await base.query(sql, params, label);
      note(label, rows.length, started);
      return rows;
    },
    explain: (sql, params, label) => base.explain(sql, params, label),
    columns(table) {
      if (!/^\w+$/.test(table)) throw new Error(`columns: unexpected table name ${table}`);
      if (!columns.has(table)) {
        columns.set(table, rowsOf(client, `DESCRIBE TABLE default.${table}`)
          .then((rows) => rows.map((row) => ({ name: row.name, type: row.type }))));
      }
      return columns.get(table);
    },
  };
}

/** FNV-1a, for a sample of chains that is the same on every run. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const SAMPLE_MOD = 499;

/**
 * Trigger writes counted by identity instead of held: no dataset reads hits
 * or chains back, and the stored batch holds about a million of each.
 */
function triggerSink(window, keep = false) {
  const hits = new Set();
  const chains = new Set();
  const latest = { hits: new Map(), chains: new Map() };
  const hitKeys = new Map();
  const chainKeys = new Map();
  const sample = new Map();
  const inWindow = (row) => row.serverDate >= window.windowStart && row.serverDate <= window.windowEnd;
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  return {
    add(batch) {
      for (const row of batch.hits ?? []) {
        const id = triggerIdentity(row);
        if (keep) latest.hits.set(id, { ...row });
        if (hits.has(id)) continue;
        hits.add(id);
        if (inWindow(row)) bump(hitKeys, row.triggerKey);
      }
      for (const row of batch.chains ?? []) {
        const id = triggerIdentity(row);
        if (keep) latest.chains.set(id, { ...row });
        if (!chains.has(id)) {
          chains.add(id);
          if (inWindow(row)) bump(chainKeys, row.triggerKey);
        }
        if (inWindow(row) && hash(id) % SAMPLE_MOD === 0) sample.set(id, { ...row });
      }
    },
    summary: () => ({
      hits: hits.size,
      chains: chains.size,
      hitsInWindow: Object.fromEntries([...hitKeys].sort()),
      chainsInWindow: Object.fromEntries([...chainKeys].sort()),
      sampled: sample.size,
    }),
    sample,
    /** Writes each kept hit and chain, last version, in identity order. */
    dump(fileOf) {
      for (const [kind, rows] of Object.entries(latest)) {
        const file = fileOf(kind);
        writeFileSync(file, '');
        let lines = [];
        for (const id of [...rows.keys()].sort()) {
          lines.push(JSON.stringify({ id, row: rows.get(id) }));
          if (lines.length === INSERT_CHUNK) {
            appendFileSync(file, `${lines.join('\n')}\n`);
            lines = [];
          }
        }
        if (lines.length > 0) appendFileSync(file, `${lines.join('\n')}\n`);
      }
    },
  };
}

const LIVE_READS = ['readPageDescriptor', 'readStoreDescriptor', 'readExperimentDescriptors', 'readTriggerDefinitions'];

/**
 * Dataset rows go to a JSONL file and a count per dataset and page. One
 * shared site state never reads them back: each finished dataset stays in
 * the state, as it does in production.
 */
function datasetSink(file) {
  writeFileSync(file, '');
  const keys = new Set();
  const counts = new Map();
  return {
    async writeDatasetRows(rows) {
      let lines = [];
      for (const row of rows) {
        const key = `${row.datasetId}|${row.idsitehsr}`;
        const id = `${key}|${row.rowKey}`;
        if (!keys.has(id)) {
          keys.add(id);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        lines.push(JSON.stringify(row));
        if (lines.length === INSERT_CHUNK) {
          appendFileSync(file, `${lines.join('\n')}\n`);
          lines = [];
        }
      }
      if (lines.length > 0) appendFileSync(file, `${lines.join('\n')}\n`);
    },
    async readDatasetRows(key) {
      throw new Error(`acceptance run holds no dataset rows to read back (${key.datasetId})`);
    },
    counts,
  };
}

/**
 * Memory persistence for every other write. The descriptor and
 * trigger-definition reads fall through to the stored rows when the run
 * has written none.
 */
function acceptancePersistence(memory, live, sink, rows) {
  const cursors = new Map();
  const persistence = { ...memory, writeDatasetRows: rows.writeDatasetRows, readDatasetRows: rows.readDatasetRows };
  for (const name of LIVE_READS) {
    persistence[name] = async (...args) => {
      const own = await memory[name](...args);
      if (own != null && (!Array.isArray(own) || own.length > 0)) return own;
      return live[name](...args);
    };
  }
  persistence.writeTriggerBatch = async (batch) => {
    if (batch.definitions?.length) await memory.writeTriggerBatch({ definitions: batch.definitions });
    sink.add(batch);
  };
  persistence.writeAnalysisCheckpoint = async (row) => {
    if (String(row.datasetId ?? '').startsWith('day-scan:')) {
      const bytes = Buffer.byteLength(String(row.notes ?? ''));
      const cell = cursors.get(row.datasetId) ?? { writes: 0, maxBytes: 0 };
      cell.writes += 1;
      cell.maxBytes = Math.max(cell.maxBytes, bytes);
      cursors.set(row.datasetId, cell);
    }
    return memory.writeAnalysisCheckpoint(row);
  };
  return { persistence, cursors };
}

function memoryWatch() {
  const peak = { rss: 0, heapUsed: 0 };
  const sample = () => {
    const usage = process.memoryUsage();
    peak.rss = Math.max(peak.rss, usage.rss);
    peak.heapUsed = Math.max(peak.heapUsed, usage.heapUsed);
  };
  const timer = setInterval(sample, 2000);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      sample();
      const mb = (n) => Math.round(n / 1048576);
      return { peakRssMb: mb(peak.rss), peakHeapMb: mb(peak.heapUsed), maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024) };
    },
  };
}

async function storedBatch(client, database, batchId, idsite) {
  const params = { batchId, idsite };
  const targets = await rowsOf(client, `
    SELECT toUInt64(idsitehsr) AS idsitehsr, status
      FROM ${database}.ae_page_target_current
     WHERE batch_id = {batchId:UUID} AND idsite = {idsite:UInt32}
     ORDER BY idsitehsr`, params);
  const datasets = await rowsOf(client, `
    SELECT dataset_id, toUInt64(idsitehsr) AS idsitehsr, count() AS n
      FROM ${database}.ae_dataset_row_current
     WHERE batch_id = {batchId:UUID} AND idsite = {idsite:UInt32}
     GROUP BY dataset_id, idsitehsr
     ORDER BY dataset_id, idsitehsr`, params);
  const site = await rowsOf(client, `
    SELECT site_name, status, reason
      FROM ${database}.ae_site_queue_current
     WHERE batch_id = {batchId:UUID} AND idsite = {idsite:UInt32}`, params);
  return { targets, datasets, site: site[0] ?? null };
}

async function storedTriggers(client, database, idsite, window) {
  const params = { idsite, start: window.windowStart, end: window.windowEnd };
  const counts = async (table) => Object.fromEntries((await rowsOf(client, `
    SELECT trigger_key, count() AS n
      FROM ${database}.${table}
     WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {start:Date} AND {end:Date}
     GROUP BY trigger_key
     ORDER BY trigger_key`, params)).map((row) => [row.trigger_key, Number(row.n)]));
  return { hitsInWindow: await counts('ae_trigger_hit_current'), chainsInWindow: await counts('ae_trigger_chain_current') };
}

/**
 * The chain outcome columns of the stored table. Its rows predate the
 * session dims (level, device, channel, and the rest), and the client
 * reads idvisit as a number past 2^53, so the read takes it as text.
 */
const CHAIN_FIELDS = ['returned', 'sessionsUntilReturn', 'sessionsUntilPurchase', 'purchased', 'revenue', 'secondsToPurchase', 'recovered', 'windowDays', 'windowCloses', 'final'];

async function compareChains(client, database, idsite, window, sample) {
  const ids = [...new Set([...sample.values()].map((row) => String(row.idvisit)))];
  const stored = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await rowsOf(client, `
      SELECT * REPLACE (toString(idvisit) AS idvisit)
        FROM ${database}.ae_trigger_chain_current
       WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {start:Date} AND {end:Date}
         AND toString(idvisit) IN {ids:Array(String)}`,
    { idsite, start: window.windowStart, end: window.windowEnd, ids: ids.slice(i, i + 500) });
    for (const row of rows.map(chainFromCh)) stored.set(triggerIdentity(row), row);
  }
  const fields = new Map();
  let matched = 0;
  let missing = 0;
  const examples = [];
  for (const [id, ours] of sample) {
    const theirs = stored.get(id);
    if (!theirs) {
      missing += 1;
      if (examples.length < 5) examples.push({ id, missing: true });
      continue;
    }
    const differing = CHAIN_FIELDS.filter((key) => !sameValue(ours[key], theirs[key]));
    if (differing.length === 0) matched += 1;
    for (const key of differing) fields.set(key, (fields.get(key) ?? 0) + 1);
    if (differing.length > 0 && examples.length < 5) {
      examples.push({ id, fields: Object.fromEntries(differing.map((key) => [key, { ours: ours[key], stored: theirs[key] }])) });
    }
  }
  return { sampled: sample.size, matched, missing, differingFields: Object.fromEntries(fields), examples };
}

function sameValue(a, b) {
  if (typeof b === 'number') return Math.abs(Number(a ?? 0) - b) < 0.005;
  if (typeof b === 'boolean') return Boolean(a) === b;
  return String(a ?? '') === String(b ?? '');
}

function compareDatasets(mine, stored) {
  const theirs = new Map(stored.map((row) => [`${row.dataset_id}|${row.idsitehsr}`, Number(row.n)]));
  const same = [];
  const differ = [];
  const onlyOurs = [];
  const onlyStored = [];
  for (const [k, n] of mine) {
    if (!theirs.has(k)) onlyOurs.push({ key: k, ours: n });
    else if (theirs.get(k) === n) same.push(k);
    else differ.push({ key: k, ours: n, stored: theirs.get(k) });
  }
  for (const [k, n] of theirs) if (!mine.has(k)) onlyStored.push({ key: k, stored: n });
  return { same: same.length, differ, onlyOurs, onlyStored };
}

async function spanCheck(client, idsite, window) {
  const params = { idsite, start: window.windowStart, end: window.windowEnd };
  const rows = await rowsOf(client, `
    SELECT span, gap, count() AS visits
      FROM (
        SELECT idvisit,
               groupUniqArray(d) AS days,
               arrayMax(days) - arrayMin(days) AS span,
               if(length(days) > 1, arrayMax(arrayDifference(arraySort(days))), 0) AS gap
          FROM (
            SELECT CAST(idvisit AS UInt64) AS idvisit, toUInt32(server_date) AS d
              FROM default.udp_hsrce_visits
             WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {start:Date} AND {end:Date}
            UNION ALL
            SELECT CAST(idvisit AS UInt64) AS idvisit, toUInt32(server_date) AS d
              FROM default.udp_hsrce_pageviews
             WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {start:Date} AND {end:Date}
          )
         GROUP BY idvisit
      )
     GROUP BY span, gap
     ORDER BY span, gap`, params);
  const total = rows.reduce((sum, row) => sum + Number(row.visits), 0);
  const gapAbove = (n) => rows.filter((row) => Number(row.gap) > n).reduce((sum, row) => sum + Number(row.visits), 0);
  const events = dayEvents();
  let started = Date.now();
  const ids = await rowsOf(client, spreadVisitsSql(), { ...params, events, hold: 1 });
  const spreadSeconds = (Date.now() - started) / 1000;
  started = Date.now();
  const visits = ids.slice(0, 2000).map((row) => BigInt(row.idvisit));
  const days = visits.length > 0 ? await rowsOf(client, daySql({ spread: true }), { ...params, events, visits }) : [];
  return {
    visits: total,
    bySpanAndGap: rows.map((row) => [Number(row.span), Number(row.gap), Number(row.visits)]),
    gapOver1: gapAbove(1),
    spreadQuery: { visits: ids.length, seconds: spreadSeconds, dayRowsFirstChunk: days.length, daySeconds: (Date.now() - started) / 1000 },
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The day store the flag names: `clickhouse`, or a local directory. */
function dayStoreOf(flag, raw, database) {
  if (flag === 'clickhouse') return createClickHouseDayStore({ client: dayStoreClient(raw, `${database}.ae_scan_day`), database });
  return createLocalDayStore({ dir: flag });
}

function overlapDays(flags) {
  const n = Number(flags['overlap-days'] ?? 2);
  if (!Number.isInteger(n) || n < 0) throw new Error('--overlap-days is a whole number of days');
  return n;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const idsite = Number(flags.idsite);
  const batchId = flags.batch;
  const mode = flags.mode ?? 'run';
  const dayScan = (flags['day-scan'] ?? 'on') === 'on';
  if (!Number.isInteger(idsite) || idsite <= 0 || !batchId) throw new Error('--idsite and --batch are required');
  const out = flags.out ?? path.join(os.tmpdir(), 'scan-acceptance');
  mkdirSync(out, { recursive: true });
  const tag = flags.tag;
  const logger = pino({ level: 'info' }, pino.destination({ dest: path.join(out, `${idsite}-${tag ?? mode}.log`), sync: false }));

  const env = process.env;
  const database = clickHouseDatabase(env);
  const raw = createClickHouseClient(clickHouseConfig(env));
  const client = readOnlyClient(raw);
  const live = createClickHouseAePersistence({ client, database, logger }).adapter;
  const batch = await live.getBatch(batchId);
  if (!batch) throw new Error(`batch ${batchId} not found`);
  const ownWindow = Boolean(flags['window-start'] || flags['window-end']);
  if (ownWindow && !(DATE.test(flags['window-start'] ?? '') && DATE.test(flags['window-end'] ?? '') && flags['window-start'] <= flags['window-end'])) {
    throw new Error('--window-start and --window-end are both required, YYYY-MM-DD, start first');
  }
  const window = ownWindow ? { ...batch, windowStart: flags['window-start'], windowEnd: flags['window-end'] } : batch;
  const report = { idsite, batchId, mode, tag: tag ?? null, window: { windowStart: window.windowStart, windowEnd: window.windowEnd }, started: new Date().toISOString() };
  const base = tag ?? `${mode}${mode === 'run' ? `-${dayScan ? 'on' : 'off'}` : ''}`;
  const write = () => writeFileSync(path.join(out, `${idsite}-${base}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const say = (text) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${text}\n`);

  if (mode === 'span') {
    report.span = await spanCheck(client, idsite, window);
    write();
    say(`visits ${report.span.visits}, gap over one day ${report.span.gapOver1}, spread query ${JSON.stringify(report.span.spreadQuery)}`);
    await raw.close();
    return;
  }

  const stored = await storedBatch(client, database, batchId, idsite);
  report.stored = { site: stored.site, targets: stored.targets, datasetRows: stored.datasets.reduce((sum, row) => sum + Number(row.n), 0) };
  report.stored.triggers = await storedTriggers(client, database, idsite, window);
  if (mode === 'stored') {
    report.stored.datasets = stored.datasets;
    write();
    say(`stored: ${stored.targets.length} targets, ${report.stored.datasetRows} dataset rows`);
    await raw.close();
    return;
  }

  const roles = await discoverAdapterRoles(path.join(root, 'src', 'adapters'));
  const only = flags.datasets ? new Set(flags.datasets.split(',')) : null;
  const datasets = adaptersIn(roles, 'datasets').filter((d) => !only || only.has(d.id));
  const gateway = acceptanceGateway(createGateway(client, { logger, database }), client);
  const memory = createMemoryAePersistence();
  const sink = triggerSink(window, flags['triggers-out'] === 'on');
  const rowSink = datasetSink(path.join(out, tag ? `${idsite}-${tag}-rows.jsonl` : `${idsite}-rows-${dayScan ? 'on' : 'off'}.jsonl`));
  const { persistence, cursors } = acceptancePersistence(memory.adapter, live, sink, rowSink);
  await persistence.createBatch({ ...window, batchId, status: 'running' });
  const site = { idsite, siteName: stored.site?.site_name ?? '' };
  await persistence.enqueueSites(batchId, [site]);
  await persistence.claimNextSite(batchId);

  const deps = {
    persistence,
    gateway,
    logger,
    clock: { todayUtc: () => window.windowEnd, now: () => new Date().toISOString() },
    qualifier: selectAdapter(adaptersIn(roles, 'qualifiers'), window.qualifier || 'prefer-non-home', 'qualifier'),
    pageSelector: selectAdapter(adaptersIn(roles, 'page-selectors'), window.pageSelector || 'primary-only', 'pageSelector'),
    datasets,
    trafficExclusion: selectAdapter(adaptersIn(roles, 'traffic-exclusion'), 'viewport-dead', 'trafficExclusion'),
    pageSelectorOpts: { maxPagesPerSite: window.maxPagesPerSite || 6 },
    elementNamesPath: env.ELEMENT_NAMES_PATH ?? null,
    dayScan,
    ...(flags['day-store'] ? { dayStore: { store: dayStoreOf(flags['day-store'], raw, database), overlapDays: overlapDays(flags) } } : {}),
  };
  report.run = {
    dayScan,
    datasets: datasets.length,
    qualifier: deps.qualifier.id,
    pageSelector: deps.pageSelector.id,
    dayStore: deps.dayStore ? { dir: flags['day-store'], overlapDays: deps.dayStore.overlapDays } : null,
  };
  const watch = memoryWatch();
  const state = createSiteState();
  const phases = {};
  const timed = async (name, fn) => {
    const started = Date.now();
    say(`${name} ...`);
    const result = await fn();
    phases[name] = Math.round((Date.now() - started) / 1000);
    const usage = process.memoryUsage();
    globalThis.gc?.();
    const live = globalThis.gc ? `, live ${Math.round(process.memoryUsage().heapUsed / 1048576)} MB` : '';
    say(`${name} done in ${phases[name]} s, rss ${Math.round(usage.rss / 1048576)} MB, heap ${Math.round(usage.heapUsed / 1048576)} MB${live}`);
    return result;
  };
  try {
    const qualified = await timed('qualify', () => qualify({ site, window, deps, state }));
    report.run.outcome = qualified.facts.outcome;
    if (qualified.facts.outcome === 'qualified') {
      const pages = qualified.facts.pages.map((entry) => ({ ...entry, fresh: true }));
      report.run.targets = pages.map((entry) => Number(entry.target.idsitehsr));
      const input = { site: { ...site, qualification: qualified.facts.qualification }, window, deps, pages };
      await timed('page datasets', () => collectDatasets({ ...input, scope: 'page', state }));
      await timed('site datasets', () => collectDatasets({ ...input, scope: 'site', state }));
    }
  } catch (err) {
    report.run.error = err instanceof Error ? err.stack : String(err);
    say(`failed: ${err instanceof Error ? err.message : err}`);
  }
  report.run.phases = phases;
  report.run.memory = watch.stop();
  report.run.cursors = Object.fromEntries(cursors);
  report.run.scanDays = gateway.labels.get('scan:day')?.calls ?? 0;
  report.run.queries = [...gateway.labels.values()].reduce((sum, cell) => sum + cell.calls, 0);
  report.run.labels = Object.fromEntries([...gateway.labels].sort((a, b) => b[1].maxRows - a[1].maxRows)
    .map(([label, cell]) => [label, { ...cell, seconds: Number(cell.seconds.toFixed(1)) }]));
  report.run.triggers = sink.summary();
  report.run.dayRecords = state.dayRecords?.stats() ?? null;
  if (flags['triggers-out'] === 'on') sink.dump((kind) => path.join(out, `${idsite}-${base}-${kind}.jsonl`));
  report.compare = ownWindow ? null : {
    datasets: compareDatasets(rowSink.counts, stored.datasets),
    chains: await compareChains(client, database, idsite, window, sink.sample),
  };
  report.finished = new Date().toISOString();
  write();
  say(`peak rss ${report.run.memory.peakRssMb} MB, ${report.run.queries} queries, ${report.run.scanDays} scan days`);
  say(`hits ${JSON.stringify(report.run.triggers.hitsInWindow)} stored ${JSON.stringify(report.stored.triggers.hitsInWindow)}`);
  say(`chains ${JSON.stringify(report.run.triggers.chainsInWindow)} stored ${JSON.stringify(report.stored.triggers.chainsInWindow)}`);
  if (report.run.dayRecords) say(`day records ${JSON.stringify(report.run.dayRecords)}`);
  if (report.compare) {
    say(`datasets same ${report.compare.datasets.same}, differ ${report.compare.datasets.differ.length}, only ours ${report.compare.datasets.onlyOurs.length}, only stored ${report.compare.datasets.onlyStored.length}`);
    say(`chain sample ${report.compare.chains.matched}/${report.compare.chains.sampled} match, ${report.compare.chains.missing} missing`);
  }
  logger.flush?.();
  await raw.close();
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});
