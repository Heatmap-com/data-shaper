// Characterization baseline (R0.1): py/bundle-build.py and py/bundle-trim.py are
// run against the recorded Sayii raw export in test/fixtures/bundle/sayii-raw/
// (visits.jsonl and pipeline.jsonl truncated to their first 2000 recorded rows,
// the rest verbatim). sha256 of every output file and the sorted file list are
// pinned in test/fixtures/bundle/bundle-build.hashes.json, with the python,
// pandas, and numpy versions they were recorded with under `recordedWith`.
//
// bundle-build.py reads the fixture directory as its extract directory, and
// outputs go to a fresh temp dir.
//
// Skipped (not faked) when python3 with pandas/numpy is unavailable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureDir = path.join(root, 'test/fixtures/bundle/sayii-raw');
const hashesPath = path.join(root, 'test/fixtures/bundle/bundle-build.hashes.json');

function pythonAvailable() {
  try {
    execFileSync('python3', ['-c', 'import pandas, numpy'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
const hasPython = pythonAvailable();

function toolchain() {
  const out = execFileSync('python3', ['-c', 'import sys, pandas, numpy; print(sys.version.split()[0], pandas.__version__, numpy.__version__)'], { encoding: 'utf8' });
  const [python, pandas, numpy] = out.trim().split(' ');
  return { python, pandas, numpy };
}

function hashDir(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith('.') && fs.statSync(path.join(dir, f)).isFile())
    .sort();
  const sha256 = {};
  for (const f of files) {
    sha256[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
  }
  return { files, sha256 };
}

describe.skipIf(!hasPython)('bundle-build + bundle-trim (characterization)', () => {
  let outRoot;

  beforeAll(() => {
    outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-char-'));
    execFileSync('python3', ['py/bundle-build.py', fixtureDir, path.join(outRoot, 'full')], {
      cwd: root,
      stdio: 'pipe',
    });
    execFileSync(
      'python3',
      ['py/bundle-trim.py', path.join(outRoot, 'full'), path.join(outRoot, 'sayii-4mb')],
      { cwd: root, stdio: 'pipe' },
    );
  }, 300_000);

  afterAll(() => {
    if (outRoot) fs.rmSync(outRoot, { recursive: true, force: true });
  });

  it('output file lists and sha256 hashes match the recorded fixture', () => {
    const { recordedWith, ...recorded } = JSON.parse(fs.readFileSync(hashesPath, 'utf8'));
    const actual = {
      full: hashDir(path.join(outRoot, 'full')),
      'sayii-4mb': hashDir(path.join(outRoot, 'sayii-4mb')),
    };
    const running = toolchain();
    expect(actual, `hashes recorded with ${JSON.stringify(recordedWith)}; this run used ${JSON.stringify(running)}`).toEqual(recorded);
  });

  it('never writes empty output files', () => {
    for (const dir of ['full', 'sayii-4mb']) {
      for (const f of fs.readdirSync(path.join(outRoot, dir))) {
        expect(fs.statSync(path.join(outRoot, dir, f)).size).toBeGreaterThan(0);
      }
    }
  });
});
