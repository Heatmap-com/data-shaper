#!/usr/bin/env node
/**
 * Compares two tagged scan-acceptance runs of one site by content: the
 * dataset rows by (dataset, page, row key), and with --triggers-out the
 * trigger hits and chains by identity. A dataset row's last write wins, as
 * in the store. Fields named like a timestamp (…At, …_at) are left out.
 *
 *   node scripts/compare-rows.mjs --idsite <idsite> --left <tag> --right <tag> [--out <dir>]
 *
 * Prints one line per kind and exits 1 when anything differs.
 */
import { createReadStream, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

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

const TIMESTAMP = /At$|_at$/;

/** JSON with sorted keys and the timestamp fields left out. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => !TIMESTAMP.test(key)).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** @param {string} file @param {(row: object) => [string, object]} entry */
async function load(file, entry) {
  const map = new Map();
  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const [key, value] = entry(JSON.parse(line));
    map.set(key, canonical(value));
  }
  return map;
}

function compare(left, right) {
  let same = 0;
  const differ = [];
  const onlyLeft = [];
  const onlyRight = [];
  for (const [key, value] of left) {
    if (!right.has(key)) onlyLeft.push(key);
    else if (right.get(key) === value) same += 1;
    else differ.push({ key, left: value.slice(0, 400), right: right.get(key).slice(0, 400) });
  }
  for (const key of right.keys()) if (!left.has(key)) onlyRight.push(key);
  return { left: left.size, right: right.size, same, differ: differ.length, onlyLeft: onlyLeft.length, onlyRight: onlyRight.length, examples: { differ: differ.slice(0, 3), onlyLeft: onlyLeft.slice(0, 3), onlyRight: onlyRight.slice(0, 3) } };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const { idsite, left, right } = flags;
  if (!idsite || !left || !right) throw new Error('--idsite, --left, and --right are required');
  const out = flags.out ?? path.join(os.tmpdir(), 'scan-acceptance');
  const fileOf = (tag, kind) => path.join(out, `${idsite}-${tag}-${kind}.jsonl`);
  const kinds = {
    rows: (row) => [`${row.datasetId}|${row.idsitehsr}|${row.rowKey}`, row],
    hits: ({ id, row }) => [id, row],
    chains: ({ id, row }) => [id, row],
  };
  let differs = false;
  const report = {};
  for (const [kind, entry] of Object.entries(kinds)) {
    const files = [fileOf(left, kind), fileOf(right, kind)];
    if (!files.every((file) => existsSync(file))) {
      if (kind === 'rows') throw new Error(`missing ${files.filter((file) => !existsSync(file)).join(', ')}`);
      continue;
    }
    const result = compare(await load(files[0], entry), await load(files[1], entry));
    report[kind] = result;
    const equal = result.differ === 0 && result.onlyLeft === 0 && result.onlyRight === 0;
    if (!equal) differs = true;
    process.stdout.write(`${kind}: ${equal ? 'equal' : 'DIFFER'} (${result.left} vs ${result.right}; same ${result.same}, differ ${result.differ}, only ${left} ${result.onlyLeft}, only ${right} ${result.onlyRight})\n`);
    if (!equal) process.stdout.write(`${JSON.stringify(result.examples, null, 2)}\n`);
  }
  if (flags.json) process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(differs ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
