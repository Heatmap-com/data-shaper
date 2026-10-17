// R1.1 exit contract for the naming seed scripts: 0 = named, 2 = usage
// (bad/missing args), 3 = missing config (required env var unset or empty).
// These tests never run a real seed: only the usage and config branches.
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../bin');

// Scrubbed environment: PATH only, so the required naming env vars are unset.
const scrubbedEnv = { PATH: process.env.PATH };

function run(script, args, env) {
  return new Promise((resolve) => {
    execFile('bash', [path.join(bin, script), ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

describe('seed-named-page.sh exit contract', () => {
  it('exits 2 on missing args', async () => {
    const r = await run('seed-named-page.sh', [], scrubbedEnv);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/usage:/);
  });

  it('exits 2 on a non-numeric idsite', async () => {
    const r = await run('seed-named-page.sh', ['https://x.com/', 'abc'], scrubbedEnv);
    expect(r.code).toBe(2);
  });

  it('exits 3 when NAMING_ENGINE_ASSETS is unset, including when CNN_AI_BOT_DIR is unset', async () => {
    const r = await run('seed-named-page.sh', ['https://x.com/', '123'], scrubbedEnv);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/missing config/);
  });

  it('exits 3 when only NAMING_ENGINE_ASSETS is unset', async () => {
    const r = await run('seed-named-page.sh', ['https://x.com/', '123'], {
      ...scrubbedEnv,
      CNN_AI_BOT_DIR: '/nonexistent',
    });
    expect(r.code).toBe(3);
  });

  it('a set-but-missing CNN_AI_BOT_DIR is not exit 3 (fails naturally)', async () => {
    const r = await run('seed-named-page.sh', ['https://x.com/', '123'], {
      ...scrubbedEnv,
      CNN_AI_BOT_DIR: '/nonexistent-bot-dir',
      NAMING_ENGINE_ASSETS: '/nonexistent-assets',
    });
    expect(r.code).not.toBe(3);
    expect(r.code).not.toBe(0);
    expect(r.code).not.toBe(2);
  });
});

describe('name-page.sh exit contract', () => {
  it('exits 2 on missing args', async () => {
    const r = await run('name-page.sh', [], scrubbedEnv);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/usage:/);
  });

  it('exits 3 when NAMING_CONTAINER is unset', async () => {
    const r = await run('name-page.sh', ['https://x.com/', '123'], scrubbedEnv);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/missing config/);
  });
});
