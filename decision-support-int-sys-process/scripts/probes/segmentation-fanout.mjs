#!/usr/bin/env node
/**
 * Probe, read only: what the segmentation fan-out costs. Times the trend's
 * template-path query over one site's window, three runs each:
 *
 *   default   the shipped trend selection (traffic_source, returning, buyer, rager)
 *   wide      the default plus channel and return_intent
 *
 * It also checks that both variants give the same `all` sessions per
 * (week, viewport, path). The SG0.6 run, before the fan-out shipped, timed
 * the crossed query against a hand-built fan-out; its numbers are in
 * docs/probes/2026-10-segmentation-fanout.md.
 *
 *   node scripts/probes/segmentation-fanout.mjs --idsite <idsite> --w0 YYYY-MM-DD --w1 YYYY-MM-DD
 */
import pino from 'pino';
import { clickHouseConfig, clickHouseDatabase, createClickHouseClient } from '../../src/composition/clickhouse.js';
import { createClickHouseAePersistence } from '../../src/adapters/persistence/clickhouse.js';
import { runInputs } from '../../src/enrichment/segmentation-inputs.js';
import { groupParams, planGroups } from '../../src/enrichment/segmentation-sql.js';
import { pathMatchList, rankMoneyPaths } from '../../src/enrichment/trend-aggregate.js';
import { pathAggregateSql, pathRankSql } from '../../src/enrichment/trend-sql.js';
import { readOnlyClient, rowsOf } from '../lib/read-only-warehouse.mjs';
import { loadSegmentationRegistry } from '../../src/composition/segmentations.js';

const SETTINGS = `
SETTINGS max_execution_time = 600,
         max_bytes_before_external_group_by = 2147483648,
         timeout_before_checking_execution_speed = 0`;

function flag(name) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0 || !process.argv[at + 1]) throw new Error(`--${name} is required`);
  return process.argv[at + 1];
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const idsite = Number(flag('idsite'));
const w0 = flag('w0');
const w1 = flag('w1');
const env = process.env;
const raw = createClickHouseClient(clickHouseConfig(env));
const client = readOnlyClient(raw);
const logger = pino({ level: 'silent' });
const out = { run_at: new Date().toISOString(), idsite, window: { w0, w1 }, variants: {} };
try {
  const live = createClickHouseAePersistence({ client, database: clickHouseDatabase(env), logger }).adapter;
  const registry = await loadSegmentationRegistry(env);
  let paths = (await live.readTrendSubjects(idsite)).paths ?? [];
  out.pathSource = 'stored';
  if (paths.length === 0) {
    const ranked = await rowsOf(client, `${pathRankSql()}${SETTINGS}`, { idsite, w0, w1 });
    paths = rankMoneyPaths(ranked.filter((row) => row.kind === 'template').map((row) => ({ path: row.path, revenue: Number(row.revenue), sessions: Number(row.sessions) })), 3);
    out.pathSource = 'ranked';
  }
  out.paths = paths;
  const match = pathMatchList(paths);
  const params = { idsite, w0, w1, templateExact: match.exact, templateExt: match.extensions };
  const selections = {
    default: registry.select(idsite, 'trend'),
    wide: registry.select(idsite, 'trend', [...registry.defaults(idsite, 'trend'), 'channel', 'return_intent']),
  };
  const results = {};
  for (const [name, segmentations] of Object.entries(selections)) {
    const inputs = { ...(await runInputs(segmentations, { idsite, persistence: live })), start: w0 };
    const groups = planGroups(segmentations);
    const seconds = [];
    let rows = [];
    for (let run = 0; run < 3; run += 1) {
      const started = Date.now();
      rows = [];
      for (const group of groups) {
        const sql = `-- probe:segmentation-fanout ${name}\n${pathAggregateSql('template', group, inputs)}${SETTINGS}`;
        rows.push(...await rowsOf(client, sql, { ...params, ...groupParams(group, inputs) }));
      }
      seconds.push((Date.now() - started) / 1000);
    }
    results[name] = rows;
    out.variants[name] = {
      segmentations: segmentations.map((seg) => seg.id),
      groups: groups.length,
      seconds: seconds.map((s) => Math.round(s * 10) / 10),
      median: Math.round(median(seconds) * 10) / 10,
      rows: rows.length,
    };
  }
  const key = (row) => `${row.week_start}|${row.viewport_value}|${row.path}`;
  const totals = (rows) => new Map(rows.filter((row) => row.segment === 'all').map((row) => [key(row), Number(row.sessions)]));
  const narrow = totals(results.default);
  const wide = totals(results.wide);
  const differ = [...new Set([...narrow.keys(), ...wide.keys()])].filter((k) => narrow.get(k) !== wide.get(k));
  out.allRowsMatch = { cells: narrow.size, differ: differ.length, sample: differ.slice(0, 5) };
} finally {
  await raw.close();
}
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
