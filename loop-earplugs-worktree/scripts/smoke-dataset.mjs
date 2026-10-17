// Live smoke for one dataset adapter against a real page. Usage:
//   node scripts/smoke-dataset.mjs <adapter-file> <idsite> <idsitehsr>
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { clickHouseConfig, createClickHouse } from '../src/composition/clickhouse.js';

const [file, idsiteArg, hsrArg] = process.argv.slice(2);
const mod = await import(pathToFileURL(path.resolve(file)).href);

const logger = { info: (o, m) => console.log(`[gateway] ${m ?? o} ${m ? JSON.stringify(o) : ''}`), warn() {}, error() {} };
const { client, gateway } = createClickHouse(clickHouseConfig(process.env), { logger });

const today = new Date().toISOString().slice(0, 10);
const end = new Date(`${today}T00:00:00Z`);
end.setUTCDate(end.getUTCDate() - 1);
const start = new Date(end);
start.setUTCDate(start.getUTCDate() - 6);
const fmt = (d) => d.toISOString().slice(0, 10);

const ctx = {
  batchId: 'smoke',
  windowStart: fmt(start),
  windowEnd: fmt(end),
  gateway,
  logger,
  clock: { todayUtc: () => today },
  datasets: new Map(),
  batchNotes: new Map(),
};

const page = {
  idsite: Number(idsiteArg),
  siteName: 'smoke',
  idsitehsr: Number(hsrArg),
  url: '',
  pageTitle: '',
  pageType: '',
  qualified: { entrySessions: 0, orders: 0, revenue: 0 },
  unfiltered: { sessions: 0, orders: 0, revenue: 0 },
  botSessionsExcluded: 0,
};

const dataset = await mod.adapter.collect(page, ctx);
console.log(`\n== ${dataset.id}: ${dataset.rows.length} rows`);
console.log('notes:', JSON.stringify(dataset.notes));
for (const row of dataset.rows.slice(0, 6)) {
  console.log(JSON.stringify({ dims: row.dims, metrics: row.metrics }));
}
process.exit(0);
