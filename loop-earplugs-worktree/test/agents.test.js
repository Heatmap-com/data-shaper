import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBotRunner, runBotCommand } from '../src/capture/bot-runner.js';
import { createHarvester } from '../src/capture/harvester.js';
import { loadConfig } from '../src/config.js';
import { runNamingAgents } from '../src/naming-consumer.js';
import { mapNameRows } from '../src/naming-mapper.js';
import { runBatch } from '../src/runner.js';
import { createMemoryPersistence } from '../src/adapters/persistence/memory.js';

const harvester = createHarvester({ botRunner: createBotRunner({ env: process.env }) });

const logger = { info() {}, warn() {}, error() {} };
const clock = { todayUtc: () => '2026-10-04' };
const window = { windowStart: '2026-09-27', windowEnd: '2026-10-03' };

let tmp;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'agents-test-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  delete process.env.NAMING_STUB_ROOT;
});

describe('loadConfig', () => {
  it('env overrides the config file, file overrides defaults', async () => {
    await writeFile(
      path.join(tmp, 'cfg.json'),
      JSON.stringify({ agents: { analysis: 2, naming: 3 }, naming: { botDir: '/bot' } }),
    );
    const fromFile = loadConfig({ ANALYSIS_CONFIG: path.join(tmp, 'cfg.json') });
    expect(fromFile.agents).toEqual({ analysis: 2, naming: 3 });
    expect(fromFile.naming.command).toBe(
      `${path.resolve('bin/seed-named-page.sh')} {url} {idsite}`,
    );
    expect(fromFile.naming.datasetRoot).toBe('/bot/dataset');

    const overridden = loadConfig({
      ANALYSIS_CONFIG: path.join(tmp, 'cfg.json'),
      NAMING_AGENTS: '5',
      ANALYSIS_AGENTS: '4',
    });
    expect(overridden.agents).toEqual({ analysis: 4, naming: 5 });

    // a missing config file yields defaults (point away from the repo's own
    // analysis.config.json, which loadConfig picks up relative to cwd)
    const defaults = loadConfig({ ANALYSIS_CONFIG: path.join(tmp, 'missing.json') });
    expect(defaults.agents).toEqual({ analysis: 1, naming: 1 });
    expect(defaults.naming.command).toBe('');
  });

  it('turns the day scan on by default, off by file or ANALYSIS_DAY_SCAN=0', async () => {
    const missing = path.join(tmp, 'missing.json');
    expect(loadConfig({ ANALYSIS_CONFIG: missing }).dayScan).toBe(true);
    expect(loadConfig({ ANALYSIS_CONFIG: missing, ANALYSIS_DAY_SCAN: '0' }).dayScan).toBe(false);
    await writeFile(path.join(tmp, 'cfg.json'), JSON.stringify({ dayScan: false }));
    expect(loadConfig({ ANALYSIS_CONFIG: path.join(tmp, 'cfg.json') }).dayScan).toBe(false);
    expect(loadConfig({ ANALYSIS_CONFIG: path.join(tmp, 'cfg.json'), ANALYSIS_DAY_SCAN: '1' }).dayScan).toBe(true);
  });

  it('keeps the scanned days in the local day store by default, set by file or environment', async () => {
    const missing = path.join(tmp, 'missing.json');
    expect(loadConfig({ ANALYSIS_CONFIG: missing }).dayStore).toEqual({
      adapter: 'local',
      dir: path.join(homedir(), '.cache', 'analysis-engine', 'day-records'),
      overlapDays: 2,
      keepDays: 400,
    });
    await writeFile(path.join(tmp, 'cfg.json'), JSON.stringify({ dayStore: { adapter: 'clickhouse', dir: '/d', overlapDays: 4, keepDays: 90 } }));
    const file = path.join(tmp, 'cfg.json');
    expect(loadConfig({ ANALYSIS_CONFIG: file }).dayStore).toEqual({ adapter: 'clickhouse', dir: '/d', overlapDays: 4, keepDays: 90 });
    const env = { ANALYSIS_CONFIG: file, ANALYSIS_DAY_STORE: 'off', ANALYSIS_DAY_STORE_DIR: '/e', ANALYSIS_DAY_OVERLAP: '1', ANALYSIS_DAY_KEEP: '30' };
    expect(loadConfig(env).dayStore).toEqual({ adapter: 'off', dir: '/e', overlapDays: 1, keepDays: 30 });
  });

  it('reads assetsDir and container from the file or the environment', async () => {
    await writeFile(
      path.join(tmp, 'cfg.json'),
      JSON.stringify({ naming: { assetsDir: '/assets', container: 'naming-bot' } }),
    );
    const fromFile = loadConfig({ ANALYSIS_CONFIG: path.join(tmp, 'cfg.json') });
    expect(fromFile.naming.assetsDir).toBe('/assets');
    expect(fromFile.naming.container).toBe('naming-bot');
    const overridden = loadConfig({
      ANALYSIS_CONFIG: path.join(tmp, 'cfg.json'),
      NAMING_ENGINE_ASSETS: '/other',
      NAMING_CONTAINER: 'other-bot',
    });
    expect(overridden.naming.assetsDir).toBe('/other');
    expect(overridden.naming.container).toBe('other-bot');
  });
});

describe('runBotCommand environment', () => {
  it('passes botDir, assetsDir, and container to the child', async () => {
    const script = path.join(tmp, 'show-env.mjs');
    const out = path.join(tmp, 'env.txt');
    await writeFile(script, `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], [process.env.CNN_AI_BOT_DIR, process.env.NAMING_ENGINE_ASSETS, process.env.NAMING_CONTAINER, process.env.PATH ? 'path' : ''].join('\\n'));\n`);
    await runBotCommand(
      { url: 'https://x.com/', idsite: 1, idsitehsr: 1 },
      { command: `node ${script} ${out} {url} {idsite}`, botDir: '/bot', assetsDir: '/assets', container: 'naming-bot', botTimeoutMs: 10_000 },
      logger,
      { PATH: process.env.PATH },
    );
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(out, 'utf8')).toBe('/bot\n/assets\nnaming-bot\npath');
  });

  it('passes a URL that contains a space as one argument', async () => {
    const script = path.join(tmp, 'show-argv.mjs');
    const out = path.join(tmp, 'argv.txt');
    await writeFile(script, `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n`);
    await runBotCommand(
      { url: 'https://loopearplugs.com/collections/all?utm_term=loop earplugs', idsite: 558, idsitehsr: 1 },
      { command: `node ${script} ${out} {url} {idsite}`, botTimeoutMs: 10_000 },
      logger,
      { PATH: process.env.PATH },
    );
    const { readFileSync } = await import('node:fs');
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual([
      'https://loopearplugs.com/collections/all?utm_term=loop%20earplugs',
      '558',
    ]);
  });
});

describe('mapNameRows', () => {
  const row = (name, selector = 'html > body > a', linkClass = '') => ({
    name,
    type: 'page',
    selector,
    rollup: false,
    attention: false,
    tags: '',
    notes: '',
    linkClass,
  });

  it('maps confident rows and skips the rest', () => {
    const names = mapNameRows([
      row('Hamburger Menu Button', 'header > button'),
      row('Primary Nav Item - Shop', 'header nav a.shop'),
      row('Announcement Bar', 'aside.announcement'),
      row('Product Card - Summit', 'div.card', 'product'),
      row('Add to Cart Button', 'button.atc'),
      row('FAQ Question - Shipping?', 'div.faq-q'),
      row('FAQ', 'section.faq-accordion'),
      row('Section - Footer', 'footer'),
      row('Image - Hero', 'img.hero'),
    ]);
    const bySelector = new Map(names.map((n) => [n.selector, n.element_class]));
    expect(bySelector.get('header > button')).toBe('nav_toggle');
    expect(bySelector.get('header nav a.shop')).toBe('nav_link');
    expect(bySelector.get('aside.announcement')).toBe('announcement_bar');
    expect(bySelector.get('div.card')).toBe('product_tile');
    expect(bySelector.get('button.atc')).toBe('offer_add_to_cart');
    expect(bySelector.get('div.faq-q')).toBe('faq_item');
    // shared accordion and generic rows stay unnamed
    expect(bySelector.has('section.faq-accordion')).toBe(false);
    expect(bySelector.has('footer')).toBe(false);
    expect(bySelector.has('img.hero')).toBe(false);
    for (const n of names) {
      expect(n.element_class).toMatch(/^[a-z_]+$/);
    }
  });
});

describe('parallel analysis agents', () => {
  it('three agents process six sites, each exactly once, with real overlap', async () => {
    const siteIds = [1, 2, 3, 4, 5, 6];
    const processed = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const qualifier = {
      id: 'q',
      config: { minShareOfHome: 0.5, minSessions: 1000, minOrders: 5 },
      async qualify(site) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        processed.push(site.idsite);
        return {
          status: 'qualified',
          idsitehsr: 10 + site.idsite,
          url: `https://x.com/${site.idsite}`,
          pageType: 'content',
          entrySessions: 2000,
          orders: 10,
          revenue: 500,
          reason: 'ok',
          evidence: { title: 't', unfiltered: { sessions: 2100, orders: 10, revenue: 500 } },
        };
      },
    };
    const datasets = [
      {
        id: 'd',
        dependsOn: [],
        collect: async () => ({ id: 'd', rows: [{ dims: { bot_filter: 'none' }, metrics: {} }] }),
      },
    ];
    const { adapter } = createMemoryPersistence();
    // the naming gate requires a fresh record per qualified page
    for (const idsite of siteIds) {
      await adapter.completeNaming({
        idsite,
        idsitehsr: 10 + idsite,
        url: `https://x.com/${idsite}`,
        namedOn: '2026-10-04',
        names: [],
      });
    }
    const deps = {
      persistence: adapter,
      siteSource: { id: 's', listSites: async () => siteIds.map((idsite) => ({ idsite, siteName: 'x' })) },
      qualifier,
      datasets,
      logger,
      clock,
      gateway: null,
      siteSourceId: 's',
      agentCount: 3,
    };
    const { batchId } = await import('../src/runner.js').then((m) => m.createBatch({ ...deps, window }));
    const counts = await runBatch(batchId, { ...deps, ...window });

    expect(counts.qualified).toBe(6);
    expect([...processed].sort((a, b) => a - b)).toEqual(siteIds);
    expect(new Set(processed).size).toBe(6); // no site processed twice
    expect(maxInFlight).toBeGreaterThan(1); // agents genuinely overlapped
  }, 10000);
});

describe('parallel naming agents', () => {
  function namingConfig(root) {
    return {
      agents: { naming: 3 },
      naming: {
        command: `node ${path.resolve('test/fixtures/stub-name-bot.mjs')} {url} {idsite}`,
        botDir: '',
        datasetRoot: root,
        botTimeoutMs: 30_000,
      },
    };
  }

  it('three agents drain three queued pages through the stub bot', async () => {
    const root = path.join(tmp, 'dataset');
    process.env.NAMING_STUB_ROOT = root;
    const { adapter, snapshot } = createMemoryPersistence();
    await adapter.enqueueNaming({ idsite: 3199, idsitehsr: 63918696, url: 'https://x.com/pages/builder', pageType: 'content', reason: 'stale' });
    await adapter.enqueueNaming({ idsite: 3207, idsitehsr: 9307614, url: 'https://y.com', pageType: 'home', reason: 'stale' });
    await adapter.enqueueNaming({ idsite: 3228, idsitehsr: 64499715, url: 'https://z.com/products/scout', pageType: 'product', reason: 'stale' });

    const started = [];
    const baseClaim = adapter.claimNaming.bind(adapter);
    adapter.claimNaming = async () => {
      const job = await baseClaim();
      if (job) started.push(`${job.idsite}:${job.idsitehsr}`);
      return job;
    };

    await runNamingAgents({ persistence: adapter, config: namingConfig(root), logger, clock, harvester });

    expect(started).toHaveLength(3);
    expect(new Set(started).size).toBe(3); // exclusive claims, no duplicates
    const state = snapshot();
    expect(state.namingQueue.every((r) => r.status === 'complete')).toBe(true);
    expect(state.naming).toHaveLength(3);
    for (const record of state.naming) {
      expect(record.status).toBe('complete');
    }
    // each page got its three stub names; the mapper kept the two
    // confident rows (nav_toggle, nav_link) and dropped the footer section
    expect(state.elementNames).toHaveLength(3);
    const classes3228 = state.elementNames.find(([k]) => k === '3228:64499715')[1];
    expect(classes3228.map((n) => n.element_class).sort()).toEqual(['nav_link', 'nav_toggle']);
  }, 20000);

  it('a failing bot marks the page failed and does not complete it', async () => {
    const root = path.join(tmp, 'dataset-empty');
    process.env.NAMING_STUB_ROOT = root;
    const { adapter, snapshot } = createMemoryPersistence();
    await adapter.enqueueNaming({ idsite: 1, idsitehsr: 2, url: 'https://nowhere.example/', pageType: 'home', reason: 'stale' });

    const config = {
      agents: { naming: 1 },
      naming: {
        command: 'node /nonexistent/stub-name-bot.mjs {url}',
        botDir: '',
        datasetRoot: root,
        botTimeoutMs: 5_000,
      },
    };
    await runNamingAgents({ persistence: adapter, config, logger, clock, harvester });

    const state = snapshot();
    expect(state.namingQueue[0].status).toBe('failed');
    expect(state.namingQueue[0].reason).toMatch(/bot command failed/);
    expect(state.naming).toHaveLength(0);
  }, 15000);
});
