#!/usr/bin/env node
/**
 * The bundle-4mb stage's command. Trims a full bundle whose anchors already
 * hold, then judges the trimmed folder on the anchors trim left behind.
 *
 *   node bin/export-bundle-4mb.mjs --src <bundle> --out <bundle-4mb> \
 *     --window-start <day> --window-end <day> --python <bin>
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAnchors } from '../src/orchestrator/domain/bundle-anchors.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REQUIRED = ['src', 'out', 'window-start', 'window-end', 'python'];

/**
 * @param {string[]} argv
 * @param {{say: (line: string) => void, spawn: Function}} io
 * @returns {Promise<number>}
 */
export async function exportBundle4mb(argv, io) {
  const flags = parseFlags(argv);
  for (const name of REQUIRED) {
    if (!flags[name]) return usage(io, `--${name} is required`);
  }
  const start = flags['window-start'];
  const end = flags['window-end'];
  if (!DAY.test(start) || !DAY.test(end) || start > end) {
    return usage(io, `the window ${start} to ${end} is not a date span`);
  }
  const srcProfile = JSON.parse(await readFile(path.join(flags.src, '00_site_profile.json'), 'utf8'));
  const srcCsv = await readFile(path.join(flags.src, '01_orders.csv'), 'utf8');
  const source = evaluateAnchors(srcProfile, srcCsv, { start, end });
  if (!source.ok) {
    io.say('full bundle anchors do not hold; not trimming');
    return 1;
  }
  const trimmed = await io.spawn(flags.python, [
    path.join(repo, 'py', 'bundle-trim.py'),
    flags.src,
    flags.out,
  ], { env: process.env, cwd: repo });
  if (trimmed.code !== 0) return typeof trimmed.code === 'number' ? trimmed.code : 1;
  const profile = JSON.parse(await readFile(path.join(flags.out, '00_site_profile.json'), 'utf8'));
  const csv = await readFile(path.join(flags.out, '01_orders.csv'), 'utf8');
  const result = evaluateAnchors(profile, csv, { start, end });
  if (!result.ok) {
    io.say(result.summary);
    return 1;
  }
  io.say(`bundle-4mb ${path.basename(flags.src)} anchors hold`);
  return 0;
}

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
  io.say(`export-bundle-4mb: ${message}`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await exportBundle4mb(process.argv.slice(2), { say: (line) => process.stdout.write(`${line}\n`), spawn: spawnLogged });
}
