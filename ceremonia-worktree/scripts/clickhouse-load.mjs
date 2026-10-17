// Samples ClickHouse load once a minute. Each sample is one JSON line on
// stdout and appended to process/runs/clickhouse-load.jsonl. The 5-minute
// queue monitor reads that file and reports min, max, and average.
//
//   node scripts/clickhouse-load.mjs          # every 60s until stopped
//   node scripts/clickhouse-load.mjs --once   # one sample
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickHouseConfig, createClickHouseClient } from '../src/composition/clickhouse.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logPath = path.join(repo, 'process/runs/clickhouse-load.jsonl');
const intervalMs = 60_000;

const SQL = `
SELECT
  count() AS running,
  sum(memory_usage) AS memory_bytes,
  max(elapsed) AS max_elapsed_s,
  sum(read_rows) AS read_rows,
  sum(read_bytes) AS read_bytes
FROM system.processes
WHERE query NOT ILIKE '%system.processes%'
`;

/**
 * One load sample. The inspection query is excluded, so a quiet warehouse
 * is running 0.
 * @param {import('@clickhouse/client').ClickHouseClient} client
 */
async function sample(client) {
  const rows = await (await client.query({ query: SQL, format: 'JSONEachRow' })).json();
  const row = rows[0] ?? {};
  const line = JSON.stringify({
    at: new Date().toISOString(),
    running: Number(row.running ?? 0),
    memory_bytes: Number(row.memory_bytes ?? 0),
    max_elapsed_s: Number(row.max_elapsed_s ?? 0),
    read_rows: Number(row.read_rows ?? 0),
    read_bytes: Number(row.read_bytes ?? 0),
  });
  console.log(line);
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${line}\n`);
}

const once = process.argv.includes('--once');
const client = createClickHouseClient(clickHouseConfig(process.env), { requestTimeoutMs: 30_000 });
try {
  do {
    try {
      await sample(client);
    } catch (err) {
      const line = JSON.stringify({ at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) });
      console.log(line);
      await mkdir(path.dirname(logPath), { recursive: true });
      await appendFile(logPath, `${line}\n`);
      if (once) process.exitCode = 1;
    }
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (!once);
} finally {
  await client.close();
}
