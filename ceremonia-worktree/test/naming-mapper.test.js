import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBotRunner } from '../src/capture/bot-runner.js';
import { createHarvester } from '../src/capture/harvester.js';
import { namesArtifactPath } from '../src/capture/artifacts.js';
import { assignClickClasses, classifyObserved, mapNameRows } from '../src/naming-mapper.js';
import { runNamingAgents } from '../src/naming-consumer.js';
import { createMemoryPersistence } from '../src/adapters/persistence/memory.js';

const harvester = createHarvester({ botRunner: createBotRunner({ env: process.env }) });

let tmp;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'mapper-test-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const row = (over = {}) => ({
  name: 'Hamburger Menu Button',
  type: 'page',
  selector: 'header > button.menu',
  rollup: false,
  attention: false,
  tags: '',
  notes: '',
  linkClass: '',
  ...over,
});

describe('mapNameRows robustness', () => {
  it('skips null, non-object, rollup, and selector-less rows', () => {
    const names = mapNameRows([
      null,
      'a string',
      42,
      row({ rollup: true }),
      row({ rollup: 'true' }), // stringy truthy from loose harvests
      row({ selector: '' }),
      row({ selector: '   ' }),
      row({ selector: 'header > nav > ul > li > a' , name: 'Menu Item - Shop' }),
    ]);
    expect(names).toHaveLength(1);
    expect(names[0].element_class).toBe('nav_link');
  });

  it('never emits a class outside the taxonomy, whatever the input says', () => {
    const names = mapNameRows([
      row({ name: 'buy_button' }),
      row({ name: 'Hamburger Menu Button', selector: 'button' }),
      row({ name: 'FAQ Question - Shipping?' }),
      row({ name: 'x'.repeat(5000) }),
      row({ name: 'Ünïcödé Nàv Itém', selector: 'nav > a' }),
    ]);
    for (const n of names) {
      expect(n.element_class).toMatch(/^[a-z_]+$/);
      expect(n.name.length).toBeLessThanOrEqual(500);
    }
    // the unicode nav item still classified by its selector
    expect(names.some((n) => n.element_class === 'nav_link')).toBe(true);
  });

  it('dedupes repeated selectors, first row wins', () => {
    const names = mapNameRows([
      row({ selector: 'header > button.menu', name: 'Hamburger Menu Button' }),
      row({ selector: 'header > button.menu', name: 'Menu Open' }),
      row({ selector: 'HEADER > BUTTON.MENU' }), // exact-match dedupe is case-sensitive
    ]);
    expect(names).toHaveLength(2);
    expect(names[0].name).toBe('Hamburger Menu Button');
  });

  it('handles large harvests linearly', () => {
    const rows = Array.from({ length: 20_000 }, (_, i) =>
      row({ selector: `header > nav > ul > li:nth-child(${i}) > a`, name: `Menu Item - ${i}` }),
    );
    const names = mapNameRows(rows);
    expect(names).toHaveLength(20_000);
    expect(new Set(names.map((n) => n.selector)).size).toBe(20_000);
  });

  it('bundle page context only reclasses non-offer rows', () => {
    const base = { pageUrl: 'https://x.com/pages/7r-bundle-builder' };
    const cls = (name, opts = {}) => mapNameRows([row({ name, selector: 'section > button' })], { ...base, ...opts })[0]?.element_class ?? null;
    expect(cls('Add to cart — Curious Red')).toBe('bundle_product_add');
    expect(cls('Add to cart — $149 offer')).toBe('offer_add_to_cart');
    expect(cls('Bundle checkout')).toBe('bundle_checkout');
    expect(cls('Proceed to checkout')).toBe('cart_checkout');
    expect(cls('Bundle slot 2')).toBe('bundle_slot');
    // same names off a bundle page keep the generic classes
    const off = { pageUrl: 'https://x.com/products/thing' };
    expect(mapNameRows([row({ name: 'Add to cart — Curious Red', selector: 'section > button' })], off)[0].element_class).toBe('offer_add_to_cart');
    expect(mapNameRows([row({ name: 'Button - Add To Bag', selector: 'product-form > buy-buttons > button' })], off)[0].element_class).toBe('offer_add_to_cart');
  });

  it('classes a quick-add control before the product-tile test', () => {
    expect(mapNameRows([row({
      name: 'Button - Quick Add Product Tile Grid Best',
      selector: 'div.carousel > div:nth-child(1) > button.quick-add',
    })])[0].element_class).toBe('quick_add');
    expect(mapNameRows([row({
      name: 'Abigail Silk Jersey Wrap Dress Product Tile',
      selector: 'div.carousel > div:nth-child(1) > a',
    })])[0].element_class).toBe('product_tile');
    expect(classifyObserved({
      selector: 'div.carousel > button.quick-add', text: 'Quick add', tag: 'button', boxTop: 900, viewportHeight: 900,
    })).toBe('quick_add');
  });

  it('classes the hero banner anchor and leaves the modal button and footer FAQ link unnamed as those classes', () => {
    const names = mapNameRows([
      row({
        name: 'Collection Button Hero Banner new',
        selector: 'main#MainContent > div:nth-child(1) > div > div > a',
        rollup: true,
      }),
      row({
        name: 'Hero image',
        selector: 'main#MainContent > div:nth-child(1) > div > div > a > div > div > div > div > picture > img',
      }),
      row({
        name: 'Section - Hero Banner DVFFall26',
        selector: 'main#MainContent > div:nth-child(1) > div > div > a > div',
      }),
      row({
        name: 'Button - Shop Now',
        selector: 'button#md-btn__form__onSubmit',
      }),
      row({
        name: 'Footer FAQ Link',
        selector: 'body#diane-von-furstenberg > footer > div > a',
      }),
      row({
        name: 'FAQ Question - How do returns work?',
        selector: 'section.faq > button.question',
      }),
    ]);
    const byName = Object.fromEntries(names.map((n) => [n.name, n.element_class]));
    expect(byName['Collection Button Hero Banner new']).toBe('hero_cta');
    expect(byName['Hero image']).toBeUndefined();
    expect(byName['Section - Hero Banner DVFFall26']).toBeUndefined();
    expect(byName['Button - Shop Now']).toBeUndefined();
    expect(byName['Footer FAQ Link']).toBeUndefined();
    expect(byName['FAQ Question - How do returns work?']).toBe('faq_item');
  });

  it('nav containers stay unnamed, terminal tag wins inside nav context', () => {
    expect(mapNameRows([row({ name: 'Header Nav Primary', selector: 'x-header > nav > ul' })])[0]?.element_class ?? null).toBeNull();
    expect(mapNameRows([row({ name: 'Shop all', selector: 'div#mobile-menu-drawer > div.button-wrapper > a' })])[0].element_class).toBe('nav_link');
    expect(mapNameRows([row({ name: 'Mega Menu', selector: 'li > details > div' })])[0].element_class).toBe('nav_toggle');
  });
});

describe('classifyObserved', () => {
  const view = { viewportHeight: 900 };

  it('classes a first-viewport shop button as hero_cta and leaves a lower one unnamed when the cap is full', () => {
    const names = assignClickClasses([
      { selector: 'a.hero', text: 'Shop now', tag: 'a', boxTop: 420, ...view },
      { selector: 'a.mid', text: 'Shop now', tag: 'a', boxTop: 640, ...view },
      { selector: 'a.low-hero', text: 'Buy now', tag: 'a', boxTop: 800, ...view },
      { selector: 'a.fourth', text: 'Shop now', tag: 'a', boxTop: 880, ...view },
      { selector: 'a.below', text: 'Shop now', tag: 'a', boxTop: 1400, ...view },
    ]);
    const bySel = Object.fromEntries(names.map((n) => [n.selector, n.element_class]));
    expect(bySel['a.hero']).toBe('hero_cta');
    expect(bySel['a.mid']).toBe('hero_cta');
    expect(bySel['a.low-hero']).toBe('hero_cta');
    expect(bySel['a.fourth']).toBeUndefined();
    expect(bySel['a.below']).toBeUndefined();
  });

  it('does not treat a nav label or a footer link as the hero', () => {
    expect(classifyObserved({
      selector: 'ul#siteNav > li > a', text: 'Shop All', tag: 'a', boxTop: 40, ancestors: 'header > nav', ...view,
    })).toBe('nav_link');
    expect(classifyObserved({
      selector: 'footer a.logo', text: 'Shop now', tag: 'a', boxTop: 40, ancestors: 'footer', ...view,
    })).toBeNull();
  });

  it('classes cart controls before the navigation guard', () => {
    expect(classifyObserved({
      selector: 'div.cart-drawer button.close', text: 'Close', tag: 'button', ancestors: 'div.cart-drawer', boxTop: 20, ...view,
    })).toBe('cart_drawer_close');
    expect(classifyObserved({
      selector: 'div.cart-drawer a.checkout', text: 'Checkout', tag: 'a', ancestors: 'div.cart-drawer', boxTop: 80, ...view,
    })).toBe('cart_checkout');
  });

  it('classes add to cart, product links, and real faq questions', () => {
    expect(classifyObserved({
      selector: 'button.add-to-cart', text: 'Add to cart', tag: 'button', boxTop: 500, ...view,
    })).toBe('offer_add_to_cart');
    expect(classifyObserved({
      selector: 'a > img.card', text: 'Weekly case', tag: 'img', href: '/products/weekly-case', boxTop: 900, ...view,
    })).toBe('product_tile');
    expect(classifyObserved({
      selector: 'div.faq button', text: 'How does it work?', tag: 'button', ancestors: 'section.faq accordion', boxTop: 1200, ...view,
    })).toBe('faq_item');
    expect(classifyObserved({
      selector: 'div.faq button.more', text: 'Load more', tag: 'button', ancestors: 'section.faq', boxTop: 1400, ...view,
    })).toBeNull();
    expect(classifyObserved({
      selector: 'div#replo a > p', text: 'GET 40% OFF', tag: 'a', boxTop: 520, ...view,
    })).toBe('hero_cta');
  });
});

describe('namesArtifactPath', () => {
  const naming = () => ({ datasetRoot: tmp });

  it('resolves the bot dataset rule: last path segment, lowercased, root -> index', async () => {
    await mkdir(path.join(tmp, '7', 'landing', 'index'), { recursive: true });
    await writeFile(path.join(tmp, '7', 'landing', 'index', 'names.json'), '[]');
    expect(namesArtifactPath({ idsite: 7, url: 'https://x.com/' }, naming())).toBe(path.join(tmp, '7', 'landing', 'index', 'names.json'));
    expect(namesArtifactPath({ idsite: 7, url: 'https://x.com/Pages/Offer' }, naming())).toBe(path.join(tmp, '7', 'landing', 'offer', 'names.json'));
    // query and hash do not affect the slug
    expect(namesArtifactPath({ idsite: 7, url: 'https://x.com/pages/offer?a=1#top' }, naming()).endsWith(path.join('7', 'landing', 'offer', 'names.json'))).toBe(true);
  });

  it('probes every page kind and returns null for bad input without a root', () => {
    expect(namesArtifactPath({ idsite: 7, url: 'not a url' }, naming())).toBeNull();
    expect(namesArtifactPath({ idsite: 7, url: 'https://x.com/p' }, {})).toBeNull();
  });
});

describe('consumer robustness', () => {
  const logger = { info() {}, warn() {}, error() {} };
  const clock = { todayUtc: () => '2026-10-04' };

  async function seedArtifact(url, idsite, content) {
    const pathname = new URL(url).pathname;
    const slug = pathname.split('/').filter(Boolean).pop()?.toLowerCase() ?? 'index';
    const dir = path.join(tmp, String(idsite), 'landing', slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'names.json'), content);
  }

  it('malformed names.json fails the page and does not complete it', async () => {
    await seedArtifact('https://x.com/pages/lp', 1, '{not json');
    const { adapter, snapshot } = createMemoryPersistence();
    await adapter.enqueueNaming({ idsite: 1, idsitehsr: 2, url: 'https://x.com/pages/lp', pageType: 'content', reason: 'stale' });
    await runNamingAgents({
      persistence: adapter,
      harvester,
      config: { agents: { naming: 1 }, naming: { command: '', botDir: '', datasetRoot: tmp, botTimeoutMs: 5000 } },
      logger,
      clock,
    });
    expect(snapshot().namingQueue[0].status).toBe('failed');
    expect(snapshot().naming).toHaveLength(0);
  });

  it('a non-array names.json fails the page', async () => {
    await seedArtifact('https://x.com/', 1, '{"rows": []}');
    const { adapter, snapshot } = createMemoryPersistence();
    await adapter.enqueueNaming({ idsite: 1, idsitehsr: 2, url: 'https://x.com/', pageType: 'home', reason: 'stale' });
    await runNamingAgents({
      persistence: adapter,
      harvester,
      config: { agents: { naming: 1 }, naming: { command: '', botDir: '', datasetRoot: tmp, botTimeoutMs: 5000 } },
      logger,
      clock,
    });
    expect(snapshot().namingQueue[0].status).toBe('failed');
    expect(snapshot().namingQueue[0].reason).toMatch(/not a NameRow array/);
  });

  it('an empty names array still completes the page', async () => {
    await seedArtifact('https://x.com/', 1, '[]');
    const { adapter, snapshot } = createMemoryPersistence();
    await adapter.enqueueNaming({ idsite: 1, idsitehsr: 2, url: 'https://x.com/', pageType: 'home', reason: 'stale' });
    await runNamingAgents({
      persistence: adapter,
      harvester,
      config: { agents: { naming: 1 }, naming: { command: '', botDir: '', datasetRoot: tmp, botTimeoutMs: 5000 } },
      logger,
      clock,
    });
    expect(snapshot().namingQueue[0].status).toBe('complete');
    expect(snapshot().naming[0].status).toBe('complete');
    expect(snapshot().elementNames[0][1]).toEqual([]);
  });
});
