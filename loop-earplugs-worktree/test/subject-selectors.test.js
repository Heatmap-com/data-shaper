import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverSubjectSelectors } from '../src/discover.js';
import { adapter as pageByKind } from '../src/adapters/subject-selectors/page-by-kind.js';
import { adapter as pagePrimary } from '../src/adapters/subject-selectors/page-primary.js';
import { resolveCriteria } from '../src/domain/criteria.js';

const WEEK = '2026-09-28';
const PAGES = [
  { hsr: '222', url: 'https://x.com/pages/lp', title: 'LP', sessions: 500 },
  { hsr: '333', url: 'https://x.com/cart', title: 'Cart', sessions: 400, orders: 2, revenue: 80 },
  { hsr: '555', url: 'https://x.com/products/a', title: 'A', sessions: 300 },
  { hsr: '556', url: 'https://x.com/products/a?variant=2', title: 'A', sessions: 40 },
  { hsr: '666', url: 'https://x.com/collections/c', title: 'C', sessions: 200 },
  { hsr: '888', url: 'https://x.com/products/quiz-b', title: 'B', sessions: 100 },
  { hsr: '999', url: 'https://x.com/products/tiny', title: 'Tiny', sessions: 10 },
];

let nextVisit = 0;
const sessionsFor = (page) => Array.from({ length: page.sessions }, (_, i) => {
  nextVisit += 1;
  const last = i === page.sessions - 1;
  return {
    idvisit: String(nextVisit), first_date: WEEK, week: WEEK, device: 1, referer: 2, returning: 0, entry_hsr: page.hsr,
    country: 'us', browser: 'Chrome', fp_hash: 'fp1', utm_source: '', pageviews: 2, capped_ms: 20000,
    saw_product: 0, saw_atc: 0, saw_checkout: 0, saw_purchase: 0,
    orders: page.orders && last ? page.orders : 0, revenue: page.revenue && last ? page.revenue : 0,
  };
});

function makeCtx() {
  const sessions = PAGES.flatMap(sessionsFor);
  const gateway = {
    async query(sql, params, label) {
      if (label === 'sessions:entry') return sessions;
      if (label === 'urls:site-hsr-pages') return PAGES.map((p) => ({ hsr: p.hsr, url: p.url, title: p.title }));
      if (label.startsWith('bot:')) return [];
      throw new Error(`unexpected query: ${label}`);
    },
    async explain() { return 'plan'; },
    async columns() { return []; },
  };
  return {
    batchId: 'b1', windowStart: '2026-09-26', windowEnd: '2026-10-02', gateway,
    logger: { info() {}, warn() {}, error() {} }, clock: { todayUtc: () => '2026-10-03' }, datasets: new Map(), batchNotes: new Map(),
  };
}

const SITE = { idsite: 1, siteName: 'x' };
const QUALIFICATION = { status: 'qualified', idsitehsr: 222, url: 'https://x.com/pages/lp', pageType: 'content', entrySessions: 500, orders: 0, revenue: 0, evidence: { title: 'LP' } };
const keys = (subjects) => subjects.map((s) => s.subjectKey);

describe('shipped subject selectors', () => {
  it('discovers each selector with a criteria schema', async () => {
    const selectors = await discoverSubjectSelectors(path.resolve('src/adapters/subject-selectors'));
    expect(selectors.map((s) => [s.id, s.subjectType])).toEqual([['active-experiments', 'experiment'], ['catalog-funnels', 'funnel'], ['journey-paths', 'journey'], ['page-by-kind', 'page'], ['page-primary', 'page'], ['quiz-pages', 'quiz']]);
    expect(selectors.every((s) => s.descriptor.criteria.additionalProperties === false)).toBe(true);
  });

  it('page-primary selects the qualifier page as a page subject', async () => {
    expect(await pagePrimary.select(SITE, QUALIFICATION, makeCtx(), {})).toEqual([{
      idsitehsr: 222, url: 'https://x.com/pages/lp', pageTitle: 'LP', pageType: 'content', role: 'primary',
      selectionReason: 'qualifier choice', entrySessions: 500, orders: 0, revenue: 0,
      subjectType: 'page', subjectKey: '222', label: 'https://x.com/pages/lp', dims: { kind: 'content' },
    }]);
    await expect(pagePrimary.select(SITE, null, makeCtx(), {})).rejects.toThrow(/ran no qualifier/);
  });

  it('page-by-kind filters by kind, floor, and URL, most entry sessions first', async () => {
    const select = (criteria) => pageByKind.select(SITE, QUALIFICATION, makeCtx(), criteria);
    expect(keys(await select({ kinds: ['product'] }))).toEqual(['555', '888', '556', '999']);
    expect(keys(await select({ kinds: ['product'], minEntrySessions: 50 }))).toEqual(['555', '888']);
    expect(keys(await select({ kinds: ['product', 'collection'], limitPerSite: 2 }))).toEqual(['555', '666']);
    expect(keys(await select({ urlContains: 'QUIZ' }))).toEqual(['888']);
    expect(keys(await select({}))).toEqual(['222', '333', '555', '666', '888']);
    const [cart] = await select({ kinds: ['cart'] });
    expect(cart).toMatchObject({ role: 'subject', orders: 2, revenue: 80, entrySessions: 400, dims: { kind: 'cart' } });
    expect(cart.selectionReason).toBe('cart page by entry sessions (400 exclude_confirmed sessions)');
  });

  it('page-by-kind folds a day at a time to the same subjects', async () => {
    const ctx = makeCtx();
    const folder = pageByKind.open(SITE, ctx);
    const rows = (await import('../src/adapters/_lib/session-stream.js')).fetchSessionRows;
    const all = await rows(ctx, SITE.idsite);
    folder.fold(all.slice(0, 700));
    folder.fold(all.slice(700));
    expect(keys(await folder.finish(SITE, QUALIFICATION, ctx, { kinds: ['product'] }))).toEqual(['555', '888', '556', '999']);
  });

  it('checks criteria against the page-by-kind schema', async () => {
    const selectors = await discoverSubjectSelectors(path.resolve('src/adapters/subject-selectors'));
    const schema = selectors.find((s) => s.id === 'page-by-kind').descriptor.criteria;
    expect(resolveCriteria(schema, { kinds: ['product'], minEntrySessions: 100 }, { minEntrySessions: 30 }))
      .toEqual({ kinds: ['product'], minEntrySessions: 30 });
    expect(() => resolveCriteria(schema, {}, { kinds: ['pdp'] })).toThrow(/criteria.kinds\[0\] must be one of/);
    expect(() => resolveCriteria(schema, {}, { minEntrySesions: 5 })).toThrow(/minEntrySesions is not a criterion/);
  });
});

describe('subject selector discovery', () => {
  let dir;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function selector(body, descriptor) {
    dir = await mkdtemp(path.join(tmpdir(), 'subject-selectors-'));
    await writeFile(path.join(dir, 'one.js'), `export const adapter = ${body};\n`);
    await writeFile(path.join(dir, 'one.descriptor.json'), JSON.stringify({ id: 'one', purpose: 'Selects.', data: 'Subjects.', ...descriptor }));
    return discoverSubjectSelectors(dir);
  }
  const closed = { type: 'object', properties: {}, additionalProperties: false };

  it('refuses an unknown subject type', async () => {
    await expect(selector("{ id: 'one', subjectType: 'widget', select: async () => [] }", { criteria: closed })).rejects.toThrow(/subjectType "widget"; known: page, quiz/);
  });

  it('refuses a selector with no criteria schema', async () => {
    await expect(selector("{ id: 'one', subjectType: 'page', select: async () => [] }", {})).rejects.toThrow(/no criteria schema/);
  });

  it('refuses a criteria schema open to unknown properties', async () => {
    await expect(selector("{ id: 'one', subjectType: 'page', select: async () => [] }", { criteria: { type: 'object', properties: {} } }))
      .rejects.toThrow(/needs additionalProperties: false/);
  });

  it('refuses a duplicate id', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'subject-selectors-'));
    for (const file of ['a', 'b']) {
      await writeFile(path.join(dir, `${file}.js`), "export const adapter = { id: 'one', subjectType: 'page', select: async () => [] };\n");
      await writeFile(path.join(dir, `${file}.descriptor.json`), JSON.stringify({ id: 'one', purpose: 'Selects.', data: 'Subjects.', criteria: closed }));
    }
    await expect(discoverSubjectSelectors(dir)).rejects.toThrow(/duplicate adapter id "one"/);
  });
});
