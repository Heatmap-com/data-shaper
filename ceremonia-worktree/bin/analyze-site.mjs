#!/usr/bin/env node
/**
 * The analysis stage's command: one site's batch under a profile. It
 * creates the batch, records its id in the batch file for the stage check,
 * then runs the batch for the site.
 *
 *   node bin/analyze-site.mjs --profile <id> --idsite <n> --window-start <date> --window-end <date> \
 *     --batch-file <path> [--select '<json>']
 *
 * The engine's batch window ends yesterday and spans the job window's day
 * count. The batch holds one site, so it runs with one agent. A run that leaves pages awaiting capture runs the capture consumer
 * and the batch again. Exit 2 is a usage error; any other failure exits with
 * the engine's code, or 1 when a page still awaits its capture.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string[]} argv
 * @param {{engine: (args: string[]) => Promise<{code: number, stdout: string}>, say: (line: string) => void}} io
 * @returns {Promise<number>} the exit code
 */
export async function analyzeSite(argv, io) {
  const flags = parseFlags(argv);
  for (const name of ['profile', 'idsite', 'window-start', 'window-end', 'batch-file']) {
    if (!flags[name]) return usage(io, `--${name} is required`);
  }
  if (!/^\d+$/.test(flags.idsite)) return usage(io, `--idsite must be a site id, got "${flags.idsite}"`);
  const days = dayCount(flags['window-start'], flags['window-end']);
  if (!days) return usage(io, `the window ${flags['window-start']} to ${flags['window-end']} is not a date span`);

  const select = (flags.select ?? '').trim();
  const site = ['--site-source', 'static-idsites', '--sites', flags.idsite];
  const create = ['--batch', '--profile', flags.profile, ...site, '--window-days', String(days)];
  if (select !== '' && select !== '{}') create.push('--select', select);
  const created = await io.engine(create);
  if (created.code !== 0) return created.code;
  const batchId = /^batch_id: (\S+)$/m.exec(created.stdout)?.[1];
  if (!batchId) {
    io.say(`batch creation printed no batch_id: ${created.stdout.trim()}`);
    return 1;
  }
  await mkdir(path.dirname(flags['batch-file']), { recursive: true });
  await writeFile(flags['batch-file'], `${JSON.stringify({ batchId, profile: flags.profile, idsite: Number(flags.idsite), windowDays: days })}\n`);
  io.say(`batch_id: ${batchId} (profile ${flags.profile}, ${days} days)`);
  const run = ['--run', '--batch', batchId, ...site, '--agents', '1'];
  const ran = await io.engine(run);
  if (ran.code !== 0) return ran.code;
  if (awaitingCapture(ran.stdout) === 0) return unfinished(io, batchId, ran.stdout);
  const captured = await io.engine(['--capture', '--agents', '1', '--site-source', 'static-idsites']);
  if (captured.code !== 0) return captured.code;
  const again = await io.engine(run);
  if (again.code !== 0) return again.code;
  return unfinished(io, batchId, again.stdout);
}

/**
 * Sites the closing counts line neither qualified, skipped, nor failed.
 * A site left awaiting capture is not claimable on the next pass, so a
 * zero awaitingCapture count is not success.
 * @param {string} stdout
 */
function unfinishedSites(stdout) {
  const all = [...stdout.matchAll(/"counts":(\{[^}]+\})/g)];
  if (!all.length) return 0;
  const counts = JSON.parse(all.at(-1)[1]);
  return Math.max(0, (counts.queued ?? 0) - (counts.qualified ?? 0) - (counts.skipped ?? 0) - (counts.failed ?? 0));
}

/** @param {{say: (line: string) => void}} io @param {string} batchId @param {string} stdout */
function unfinished(io, batchId, stdout) {
  const waiting = unfinishedSites(stdout);
  if (waiting === 0) return 0;
  io.say(`batch ${batchId}: ${waiting} site${waiting === 1 ? '' : 's'} still not analyzed`);
  return 1;
}

/** The sites the run's closing counts line leaves awaiting capture. @param {string} stdout */
function awaitingCapture(stdout) {
  const all = [...stdout.matchAll(/"awaitingCapture":(\d+)/g)];
  return all.length ? Number(all.at(-1)[1]) : 0;
}

/** @param {string[]} argv */
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

/** @param {string} start @param {string} end */
function dayCount(start, end) {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 86400000) + 1 : null;
}

function usage(io, message) {
  io.say(`analyze-site: ${message}`);
  return 2;
}

const HEAP_FLOOR_MB = 8192;
const HEAP_CEILING_MB = 32768;

/**
 * The analysis heap in MB: `ANALYSIS_HEAP_MB` when set, else half the
 * machine's memory between 8 and 32 GB (skills/site-analysis/SKILL.md runs
 * with 32 GB). The site pass of a site with millions of sessions a month
 * folds past 8 GB.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {number} [totalBytes]
 */
export function heapMb(env = process.env, totalBytes = os.totalmem()) {
  const asked = Number(env.ANALYSIS_HEAP_MB);
  if (Number.isInteger(asked) && asked > 0) return asked;
  return Math.min(HEAP_CEILING_MB, Math.max(HEAP_FLOOR_MB, Math.floor(totalBytes / 1024 / 1024 / 2)));
}

/**
 * The engine's node command on the analysis heap.
 *
 * @param {string[]} args
 * @param {number} [heap] MB
 */
export function engineCommand(args, heap = heapMb()) {
  return { command: process.execPath, args: ['--expose-gc', `--max-old-space-size=${heap}`, path.join(repo, 'src', 'cli.js'), ...args] };
}

/** @param {string[]} args */
function engine(args) {
  return new Promise((resolve) => {
    const { command, args: argv } = engineCommand(args);
    const child = spawn(command, argv, { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await analyzeSite(process.argv.slice(2), { engine, say: (line) => process.stdout.write(`${line}\n`) });
}
