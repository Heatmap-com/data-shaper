#!/usr/bin/env node
// Backs up the seven v1 tables before the schema-2 rebuild
// (data-capture-plan.md §8.2). Read-only against ClickHouse: streams
// SELECT * ... FORMAT JSONEachRow per table into <out>/<UTC-ts>/<table>.jsonl.gz
// and writes a manifest the rebuild script checks before dropping anything.
//
//   node scripts/backup-legacy.mjs --out backups
//
// The manifest rows must equal a fresh count() of each table at rebuild
// time, so quiesce the writers first (stop the services, §12 step 2).
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickHouseConfig, createClickHouseClient } from '../src/composition/clickhouse.js';

const execFileAsync = promisify(execFile);

/** The seven v1 objects (plan §8.1) with their ORDER BY keys and version column. */
export const LEGACY_TABLES = [
  { name: 'landing_page_batch', keys: ['batch_id'], version: 'created_at' },
  { name: 'site_queue', keys: ['batch_id', 'idsite'], version: 'generated_at' },
  { name: 'landing_page_analysis', keys: ['batch_id', 'idsite', 'idsitehsr'], version: 'generated_at' },
  { name: 'landing_page_dataset', keys: ['batch_id', 'idsite', 'idsitehsr', 'dataset_id', 'row_key'], version: 'generated_at' },
  { name: 'page_naming', keys: ['idsite', 'idsitehsr'], version: 'generated_at' },
  { name: 'naming_queue', keys: ['idsite', 'idsitehsr'], version: 'generated_at' },
  { name: 'page_element_name', keys: ['idsite', 'idsitehsr', 'selector'], version: 'generated_at' },
];

/**
 * @param {object} client @clickhouse/client instance
 * @param {string} database
 * @param {object} table LEGACY_TABLES entry
 */
async function tableStats(client, database, table) {
  const keys = table.keys.join(', ');
  const rows = await client
    .query({
      query: `SELECT count() AS rows, max(${table.version}) AS max_version, uniqExact((${keys})) AS uniq_keys
                FROM ${database}.${table.name}`,
      format: 'JSONEachRow',
    })
    .then((r) => r.json());
  return rows[0];
}

/**
 * Streams one table to <dir>/<name>.jsonl.gz; returns {rows, sha256}.
 * @param {object} client
 * @param {string} database
 * @param {object} table
 * @param {string} dir
 */
async function exportTable(client, database, table, dir) {
  const file = path.join(dir, `${table.name}.jsonl.gz`);
  const hash = createHash('sha256');
  let rows = 0;
  const toJsonl = new Transform({
    objectMode: true,
    transform(row, _enc, cb) {
      rows += 1;
      cb(null, `${JSON.stringify(row)}\n`);
    },
  });
  const gzip = createGzip();
  gzip.on('data', (chunk) => hash.update(chunk));
  const result = client.query({
    query: `SELECT * FROM ${database}.${table.name} FORMAT JSONEachRow`,
    format: 'JSONEachRow',
  });
  await pipeline(result.stream(), toJsonl, gzip, createWriteStream(file));
  return { rows, sha256: hash.digest('hex'), file };
}

/**
 * @param {object} opts
 * @param {object} opts.client
 * @param {string} opts.database the database the legacy tables live in
 * @param {string} opts.outDir destination root; the timestamped backup dir is created inside it
 * @param {string} [opts.gitSha]
 * @param {string} [opts.now] UTC timestamp for the backup dir name
 * @returns {Promise<object>} the manifest
 */
export async function backupLegacy({ client, database, outDir, gitSha = '', now }) {
  const stamp = now ?? new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(outDir, stamp);
  await mkdir(dir, { recursive: true });

  /** @type {Record<string, object>} */
  const tables = {};
  for (const table of LEGACY_TABLES) {
    const stats = await tableStats(client, database, table);
    const exported = await exportTable(client, database, table, dir);
    if (Number(stats.rows) !== exported.rows) {
      throw new Error(
        `${table.name}: exported ${exported.rows} rows but count() says ${stats.rows}; ` +
          'the table was written during the backup — re-run after quiescing the writers',
      );
    }
    tables[table.name] = {
      rows: exported.rows,
      max_version: stats.max_version ?? null,
      uniq_keys: Number(stats.uniq_keys),
      sha256: exported.sha256,
    };
    console.log(`${table.name}: ${exported.rows} rows -> ${path.relative(process.cwd(), exported.file)}`);
  }

  const manifest = {
    database,
    created_at: stamp,
    git_sha: gitSha,
    tables,
  };
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`manifest: ${path.relative(process.cwd(), path.join(dir, 'manifest.json'))}`);
  return manifest;
}

async function gitSha() {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  if (outIdx === -1 || !args[outIdx + 1]) {
    console.error('usage: node scripts/backup-legacy.mjs --out <dir>');
    process.exit(2);
  }
  const config = clickHouseConfig(process.env);
  const client = createClickHouseClient(config);
  await backupLegacy({ client, database: config.database, outDir: args[outIdx + 1], gitSha: await gitSha() });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
