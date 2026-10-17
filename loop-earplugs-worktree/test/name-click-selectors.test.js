import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { namingRequest, playwrightFrom } from '../bin/name-click-selectors.mjs';

const BATCH = '9bbe0ed1-184c-469a-9f56-cae8426b94c2';

describe('name-click-selectors inputs', () => {
  it('takes the batch and the sites from the arguments', () => {
    expect(namingRequest(['--batch', BATCH, '--sites', '11,12'])).toEqual({
      batchId: BATCH,
      sites: [{ idsite: 11, url: '' }, { idsite: 12, url: '' }],
    });
  });

  it('takes a page url with one site', () => {
    expect(namingRequest(['--batch', BATCH, '--sites', '11', '--url', 'https://shop.test/'])).toEqual({
      batchId: BATCH,
      sites: [{ idsite: 11, url: 'https://shop.test/' }],
    });
  });

  it('refuses a missing batch, missing sites, and a url shared across sites', () => {
    expect(() => namingRequest(['--sites', '11'])).toThrow(/--batch/);
    expect(() => namingRequest(['--batch', 'latest', '--sites', '11'])).toThrow(/UUID/);
    expect(() => namingRequest(['--batch', BATCH])).toThrow(/--sites/);
    expect(() => namingRequest(['--batch', BATCH, '--sites', 'eleven'])).toThrow(/positive integer/);
    expect(() => namingRequest(['--batch', BATCH, '--sites', '11,12', '--url', 'https://shop.test/'])).toThrow(/one idsite/);
  });
});

describe('playwrightFrom', () => {
  /** @type {string} */
  let botDir;
  afterEach(async () => {
    if (botDir) await rm(botDir, { recursive: true, force: true });
  });

  it('loads Playwright from the naming bot directory', async () => {
    botDir = await mkdtemp(path.join(os.tmpdir(), 'bot-'));
    const pkg = path.join(botDir, 'node_modules', 'playwright');
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(botDir, 'package.json'), '{"name":"bot"}\n');
    await writeFile(path.join(pkg, 'package.json'), '{"name":"playwright","main":"index.js"}\n');
    await writeFile(path.join(pkg, 'index.js'), "module.exports = { chromium: 'from-bot' };\n");
    expect(playwrightFrom(botDir).chromium).toBe('from-bot');
  });

  it('names the setting when the bot directory is unset', () => {
    expect(() => playwrightFrom('')).toThrow(/naming\.botDir is not set/);
  });
});
