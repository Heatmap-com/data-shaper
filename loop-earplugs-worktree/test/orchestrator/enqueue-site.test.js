import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../../src/orchestrator/adapters/queue/memory.js';
import { createSiteWriter } from '../../src/orchestrator/adapters/descriptors/site-writer.js';
import { createFsDescriptorSource } from '../../src/orchestrator/adapters/descriptors/fs.js';
import { createSiteResolver } from '../../src/orchestrator/application/resolve-site.js';
import { createEnqueue } from '../../src/orchestrator/application/enqueue-job.js';
import { chooseDirectoryRow } from '../../src/orchestrator/domain/site.js';
import { makeStage } from './orch-test-helpers.js';

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

const row = (extra = {}) => ({ idsite: 6213, name: 'Shop Co', mainUrl: 'https://shop.example', platform: 'shopify', currency: 'USD', status: 'active', ...extra });

describe('directory row choice', () => {
  it('takes the one active row for the domain and nothing else', () => {
    expect(chooseDirectoryRow('www.shop.example', [row(), row({ idsite: 1, mainUrl: 'https://shop.example.other' })]).row.idsite).toBe(6213);
    expect(chooseDirectoryRow('shop.example', []).problem).toBe('no default.sites row has the main URL shop.example');
    expect(chooseDirectoryRow('shop.example', [row({ status: 'paused' })]).problem).toMatch(/only as idsite 6213 \(paused\), with no active row/);
    expect(chooseDirectoryRow('shop.example', [row(), row({ idsite: 7 })]).problem).toMatch(/2 active default\.sites rows match shop\.example \(idsite 6213, 7\)/);
  });
});

describe('enqueue a domain with no site.json', () => {
  const setup = (rows) => {
    const root = mkdtempSync(path.join(tmpdir(), 'orch-sites-'));
    dirs.push(root);
    const store = createStore();
    const journal = [];
    const lookups = [];
    let ids = 0;
    const descriptors = createFsDescriptorSource({ root });
    const directory = { lookup: async (domain) => { lookups.push(domain); return rows; } };
    const resolved = { run: { id: 'full', defaults: {}, pages: { source: 'home' }, stages: [makeStage({ id: 'naming' })] }, refs: [{ ref: 'general:full', file: 'full.run.json' }], hash: 'h' };
    const enqueue = createEnqueue({
      siteResolver: createSiteResolver({ descriptors, directory }),
      registry: createSiteWriter({ root }),
      resolver: { resolve: async () => resolved },
      validator: { validateJob: async (job) => (job.site.idsite ? [] : ['templates reference {{site.idsite}}']) },
      jobs: store.jobs,
      queue: store.queue,
      journal: { record: async (job, event) => { journal.push(event); } },
      clock: { now: () => new Date('2026-10-13T07:00:00.000Z') },
      newId: (now, slug) => `${slug}-${(ids += 1)}`,
    });
    return { root, store, journal, lookups, enqueue };
  };

  it('looks the domain up, queues the job, and writes its site.json', async () => {
    const { root, journal, lookups, enqueue } = setup([row()]);
    const job = await enqueue({ site: 'https://shop.example/', run: 'full', priority: 'high', resilience: 'top' });
    expect(lookups).toEqual(['shop.example']);
    expect(job.site).toEqual({ slug: 'shop', name: 'Shop Co', domain: 'shop.example', origin: 'https://shop.example/', idsite: 6213, platform: 'shopify', currency: 'USD' });
    expect(JSON.parse(readFileSync(path.join(root, 'sites', 'shop', 'site.json'), 'utf8'))).toEqual(job.site);
    expect(journal[0].message).toMatch(/Site found in default\.sites \(idsite 6213, Shop Co\); wrote .*sites\/shop\/site\.json\./);
  });

  it('uses the site.json once it exists, with no second lookup', async () => {
    const { lookups, enqueue, store } = setup([row()]);
    await enqueue({ site: 'shop.example', run: 'full' });
    await store.jobs.update('shop-1', (draft) => { draft.status = 'done'; });
    await enqueue({ site: 'shop', run: 'full' });
    expect(lookups).toEqual(['shop.example']);
  });

  it('blocks with the reason when the directory has no single active row, and writes nothing', async () => {
    const { root, store, enqueue } = setup([row({ status: 'paused' })]);
    await expect(enqueue({ site: 'shop.example', run: 'full' })).rejects.toThrow(/no active row\. Add orchestration\/sites\/shop\/site\.json with its idsite and name\./);
    expect(await store.jobs.list()).toEqual([]);
    expect(() => readFileSync(path.join(root, 'sites', 'shop', 'site.json'))).toThrow();
  });

  it('refuses to overwrite a site.json another domain already owns', async () => {
    const { root, enqueue } = setup([row()]);
    mkdirSync(path.join(root, 'sites', 'shop'), { recursive: true });
    writeFileSync(path.join(root, 'sites', 'shop', 'site.json'), JSON.stringify({ slug: 'shop', domain: 'shop.other', origin: 'https://shop.other/' }));
    await expect(enqueue({ site: 'shop.example', run: 'full' })).rejects.toThrow(/already exists for another domain/);
  });
});
