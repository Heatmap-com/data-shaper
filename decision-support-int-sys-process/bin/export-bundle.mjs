#!/usr/bin/env node
/**
 * The bundle stage's command. Resolves the analysed page, extracts the
 * warehouse rows, builds the analyst folder, and exits 1 when the anchors
 * do not hold.
 *
 *   node bin/export-bundle.mjs --site <site.json> --window-start <day> --window-end <day> \
 *     --extract <dir> --out <dir> --job <id> --runs <dir> --attempt <n> --python <bin>
 */
import { spawn } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickHouseConfig, createClickHouseClient } from '../src/composition/clickhouse.js';
import { evaluateAnchors } from '../src/orchestrator/domain/bundle-anchors.js';
import { resolveFocus, withFocus } from '../src/orchestrator/domain/bundle-focus.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REQUIRED = ['site', 'window-start', 'window-end', 'extract', 'out', 'job', 'runs', 'attempt', 'python'];

/**
 * @param {string[]} argv
 * @param {{say: (line: string) => void, spawn: typeof spawnLogged, queryPage?: Function}} io
 * @returns {Promise<number>}
 */
export async function exportBundle(argv, io) {
  const flags = parseFlags(argv);
  for (const name of REQUIRED) {
    if (!flags[name]) return usage(io, `--${name} is required`);
  }
  const start = flags['window-start'];
  const end = flags['window-end'];
  if (!DAY.test(start) || !DAY.test(end) || start > end) {
    return usage(io, `the window ${start} to ${end} is not a date span`);
  }
  const site = JSON.parse(await readFile(flags.site, 'utf8'));
  for (const field of ['slug', 'idsite', 'domain', 'currency', 'platform']) {
    if (site[field] === undefined || site[field] === null || site[field] === '') {
      io.say(`site.json has no ${field}`);
      return 1;
    }
  }
  if (!Number.isInteger(site.idsite) || site.idsite <= 0) {
    io.say('site.json has no idsite');
    return 1;
  }
  if (site.platform !== String(site.platform).toLowerCase()) {
    io.say('site.json platform must be lower case');
    return 1;
  }

  let focus;
  try {
    focus = await resolveSiteFocus(site, flags, io);
  } catch (err) {
    io.say(err.message);
    return 1;
  }
  if (focus.wrote) {
    await writeFile(flags.site, `${JSON.stringify(withFocus(site, focus.value), null, 2)}\n`);
  }

  const resume = await shouldResume(flags.extract, site, start, end, Number(flags.attempt));
  const env = { ...process.env };
  if (resume) env.BUNDLE_RESUME = '1';
  else delete env.BUNDLE_RESUME;

  const extracted = await io.spawn(process.execPath, [
    path.join(repo, 'py', 'bundle-export.mjs'),
    '--site', flags.site,
    '--window-start', start,
    '--window-end', end,
    '--out', flags.extract,
  ], { env, cwd: repo });
  if (extracted.code !== 0) return numberCode(extracted.code);
  const combined = `${extracted.stdout ?? ''}\n${extracted.stderr ?? ''}`;
  if (!combined.includes(`${site.slug} visits done`)) {
    io.say(`extract finished without "${site.slug} visits done"`);
    return 1;
  }

  const built = await io.spawn(flags.python, [
    path.join(repo, 'py', 'bundle-build.py'),
    flags.extract,
    flags.out,
  ], { env: process.env, cwd: repo });
  if (built.code !== 0) return numberCode(built.code);

  const profile = JSON.parse(await readFile(path.join(flags.out, '00_site_profile.json'), 'utf8'));
  const csv = await readFile(path.join(flags.out, '01_orders.csv'), 'utf8');
  const result = evaluateAnchors(profile, csv, { start, end });
  const page = profile.analysed_page;
  const same = page?.path === focus.value.path && Number(page?.idsitehsr) === focus.value.idsitehsr;
  if (!result.ok || !same) {
    io.say(!same && result.ok
      ? `anchor mismatch: analysed page ${page?.path} (${page?.idsitehsr})`
      : result.summary);
    return 1;
  }
  io.say(`bundle ${site.slug} anchors hold`);
  return 0;
}

/**
 * Newest analysis attempt that wrote a batch file.
 * @param {string} runsRoot
 * @param {string} jobId
 */
export async function latestBatchFile(runsRoot, jobId) {
  const dir = path.join(runsRoot, jobId, 'analysis');
  const attempts = await readdir(dir).catch(() => []);
  const found = [];
  for (const name of attempts) {
    const file = path.join(dir, name, 'batch.json');
    const info = await stat(file).catch(() => null);
    if (info) found.push({ file, mtimeMs: info.mtimeMs });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!found.length) throw new Error(`site.json has no focus and ${dir} has no analysis batch`);
  return JSON.parse(await readFile(found[0].file, 'utf8'));
}

/**
 * @param {import('@clickhouse/client').ClickHouseClient} client
 * @param {string} database
 * @param {string} batchId
 * @param {number} idsite
 */
export async function pageForBatch(client, database, batchId, idsite) {
  const result = await client.query({
    query: `
      SELECT idsitehsr, url, page_title AS pageTitle, role
      FROM ${database}.ae_page_target_current
      WHERE batch_id = {batchId:UUID}
        AND idsite = {idsite:UInt32}
        AND status = 'selected'
        AND role = 'primary'
      LIMIT 1
    `,
    query_params: { batchId, idsite },
    format: 'JSONEachRow',
  });
  const rows = await result.json();
  const row = rows[0];
  if (!row) return null;
  const idsitehsr = Number(row.idsitehsr);
  return { idsitehsr, url: row.url, pageTitle: row.pageTitle };
}

async function resolveSiteFocus(site, flags, io) {
  const existing = site.focus;
  if (existing?.path && Number.isInteger(existing.idsitehsr)) {
    return { value: resolveFocus(existing, null), wrote: false };
  }
  const batch = await latestBatchFile(flags.runs, flags.job);
  if (Number(batch.idsite) !== site.idsite) {
    throw new Error(`analysis batch ${batch.batchId} is for idsite ${batch.idsite}, site.json says ${site.idsite}`);
  }
  const page = io.queryPage
    ? await io.queryPage(batch.batchId, site.idsite)
    : await queryPrimaryPage(batch.batchId, site.idsite);
  return { value: resolveFocus(undefined, page), wrote: true };
}

async function queryPrimaryPage(batchId, idsite) {
  const config = clickHouseConfig(process.env);
  const client = createClickHouseClient(config, { requestTimeoutMs: 60_000 });
  try {
    return await pageForBatch(client, config.database, batchId, idsite);
  } finally {
    await client.close();
  }
}

async function shouldResume(extract, site, start, end, attempt) {
  if (!(attempt > 1)) return false;
  const meta = JSON.parse(await readFile(path.join(extract, 'meta.json'), 'utf8').catch(() => 'null'));
  if (!meta) return false;
  return meta.slug === site.slug
    && meta.window0 === start
    && meta.window1 === end
    && Number(meta.idsite) === site.idsite;
}

/** @param {string} command @param {string[]} args @param {{env: NodeJS.ProcessEnv, cwd: string}} options */
function spawnLogged(command, args, { env, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function numberCode(code) {
  return typeof code === 'number' ? code : 1;
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      flags[argv[i].slice(2)] = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return flags;
}

function usage(io, message) {
  io.say(`export-bundle: ${message}`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await exportBundle(process.argv.slice(2), { say: (line) => process.stdout.write(`${line}\n`), spawn: spawnLogged });
}
