import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { selectBrands } from '../src/audit/brands.js';
import { loadBrands, loadSegmentationSpecs, loadTrendSeeds, orchestrationRoot } from '../src/composition/registries.js';

const BRANDS = [
  { key: 'alpha', name: 'Alpha', domain: 'alpha.test' },
  { key: 'beta', name: 'Beta', domain: 'beta.test', idsite: 4 },
];

describe('selectBrands', () => {
  it('takes every registry brand when no keys are given, with idsites aligned', () => {
    expect(selectBrands(BRANDS, undefined, [11])).toEqual([
      { key: 'alpha', name: 'Alpha', domain: 'alpha.test', idsite: 11 },
      { key: 'beta', name: 'Beta', domain: 'beta.test', idsite: 4 },
    ]);
  });

  it('picks named brands and rejects an unknown key', () => {
    expect(selectBrands(BRANDS, ['beta']).map((b) => b.key)).toEqual(['beta']);
    expect(() => selectBrands(BRANDS, ['gamma'])).toThrow(/unknown brand "gamma"; known: alpha, beta/);
  });

  it('needs a registry', () => {
    expect(() => selectBrands([], undefined)).toThrow(/brand registry/);
  });
});

describe('orchestration registries', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'registries-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'registries'));
  writeFileSync(path.join(root, 'registries', 'brands.json'), JSON.stringify({ brands: BRANDS }));
  for (const [slug, rows] of [['one', [{ idsite: 1, idsitehsr: 10, status: 'active', trendSelectors: ['#a'] }]], ['two', null]]) {
    mkdirSync(path.join(root, 'sites', slug), { recursive: true });
    if (rows) writeFileSync(path.join(root, 'sites', slug, 'trend-seeds.json'), JSON.stringify({ selectors: rows }));
  }

  it('reads the brand registry and every site seed file', async () => {
    expect(await loadBrands(root)).toEqual(BRANDS);
    expect(await loadTrendSeeds(root)).toEqual([{ idsite: 1, idsitehsr: 10, status: 'active', trendSelectors: ['#a'] }]);
  });

  it('has no seeds when there is no sites directory', async () => {
    expect(await loadTrendSeeds(path.join(root, 'registries'))).toEqual([]);
  });

  it('defaults to the repo orchestration directory', async () => {
    const repo = orchestrationRoot({});
    expect((await loadBrands(repo)).length).toBeGreaterThan(0);
    expect(orchestrationRoot({ ORCHESTRATION_ROOT: root })).toBe(root);
  });
});

describe('site segmentation files', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'segmentations-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (slug, doc) => {
    mkdirSync(path.join(root, 'sites', slug), { recursive: true });
    writeFileSync(path.join(root, 'sites', slug, 'segmentations.json'), typeof doc === 'string' ? doc : JSON.stringify(doc));
  };
  write('alpha', { idsite: 11, defaults: { trend: ['channel'] }, overrides: { channel: { remove: ['affiliate'] } } });
  write('beta', { idsite: 12, declarations: [] });
  mkdirSync(path.join(root, 'sites', 'gamma'), { recursive: true });

  it('reads every site file, filling the missing parts, and skips a site without one', async () => {
    expect(await loadSegmentationSpecs(root)).toEqual([
      { slug: 'alpha', idsite: 11, defaults: { trend: ['channel'] }, overrides: { channel: { remove: ['affiliate'] } }, declarations: [] },
      { slug: 'beta', idsite: 12, defaults: {}, overrides: {}, declarations: [] },
    ]);
    expect(await loadSegmentationSpecs(path.join(root, 'nowhere'))).toEqual([]);
  });

  it('refuses two files for one idsite, naming both slugs', async () => {
    const dup = mkdtempSync(path.join(tmpdir(), 'segmentations-dup-'));
    try {
      for (const slug of ['one', 'two']) {
        mkdirSync(path.join(dup, 'sites', slug), { recursive: true });
        writeFileSync(path.join(dup, 'sites', slug, 'segmentations.json'), JSON.stringify({ idsite: 7 }));
      }
      await expect(loadSegmentationSpecs(dup)).rejects.toThrow('idsite 7 has two segmentation files: sites/one and sites/two');
    } finally {
      rmSync(dup, { recursive: true, force: true });
    }
  });

  it('refuses a bad shape, naming the file', async () => {
    for (const [doc, message] of [
      ['{', /sites\/delta\/segmentations.json: /],
      [{ idsite: 0 }, /idsite must be a positive integer/],
      [{ idsite: 13, extra: 1 }, /unknown keys extra/],
      [{ idsite: 13, defaults: [] }, /defaults must be an object/],
      [{ idsite: 13, declarations: {} }, /declarations must be a list/],
    ]) {
      write('delta', doc);
      await expect(loadSegmentationSpecs(root)).rejects.toThrow(message);
    }
    rmSync(path.join(root, 'sites', 'delta'), { recursive: true, force: true });
  });
});
