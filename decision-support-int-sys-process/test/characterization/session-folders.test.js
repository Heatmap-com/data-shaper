import { describe, expect, it } from 'vitest';
import { fetchSessionRows } from '../../src/adapters/_lib/session-stream.js';
import { adapter as entryByChannel } from '../../src/adapters/datasets/entry-by-channel.js';
import { adapter as siteBaselines } from '../../src/adapters/datasets/site-baselines.js';
import { adapter as defaultSix } from '../../src/adapters/page-selectors/default-six.js';
import { adapter as preferNonHome } from '../../src/adapters/qualifiers/prefer-non-home.js';

/**
 * The four session reductions the day scan's site pass folds: the
 * qualifier, the page selector, entry-by-channel, and site-baselines,
 * on one generated site. The snapshot was recorded on the window-query
 * path before the folders existed.
 */

export const IDSITE = 7;
export const WINDOW = { windowStart: '2026-09-07', windowEnd: '2026-09-20' };

const PAGES = [
  ['11', 'https://x.com/', 'Home'],
  ['12', 'https://x.com/products/a', 'A'],
  ['13', 'https://x.com/products/b', 'B'],
  ['14', 'https://x.com/collections/c', 'C'],
  ['15', 'https://x.com/cart', 'Cart'],
  ['16', 'https://x.com/pages/about', 'About'],
  ['17', 'https://x.com/products/a', 'A again'],
  ['18', '', 'No URL'],
];

/** Deterministic session rows in the window query's raw shape. */
export function sessionRows() {
  const rows = [];
  const entries = ['11', '11', '11', '12', '12', '13', '14', '15', '16', '17', '18', '0', ''];
  for (let i = 0; i < 400; i += 1) {
    const day = 7 + (i % 14);
    const date = `2026-09-${String(day).padStart(2, '0')}`;
    rows.push({
      idvisit: String(10_000 + i),
      first_date: date,
      week: day < 14 ? '2026-09-07' : '2026-09-14',
      device: 1 + (i % 3),
      referer: 1 + (i % 4 === 0 ? 2 : i % 2),
      returning: i % 5 === 0 ? 1 : 0,
      entry_hsr: entries[i % entries.length],
      country: ['us', 'ca', 'gb'][i % 3],
      browser: 'CH',
      fp_hash: String(i % 11),
      utm_source: '',
      pageviews: 1 + (i % 4),
      capped_ms: 1000 * (i % 7),
      saw_product: i % 3 === 0 ? 1 : 0,
      saw_atc: i % 7 === 0 ? 1 : 0,
      saw_checkout: i % 13 === 0 ? 1 : 0,
      saw_purchase: i % 17 === 0 ? 1 : 0,
      orders: i % 17 === 0 ? 1 : 0,
      revenue: i % 17 === 0 ? 40 + (i % 9) : 0,
    });
  }
  return rows;
}

/** Second pageviews: every third visit's second page returns to its entry. */
export function secondPages(rows) {
  return rows
    .filter((row) => row.pageviews > 1)
    .map((row, index) => ({ idvisit: row.idvisit, hsr: index % 3 === 0 ? row.entry_hsr : '16' }));
}

/** fp 9 is confirmed, fp 8 suspect (rescued when it shows a commerce signal). */
export const BOT = {
  tierOf: (_week, fp) => (fp === '9' ? { tier: 'confirmed', reasons: ['square'] } : fp === '8' ? { tier: 'suspect', reasons: ['spike'] } : null),
  notes: {},
};

export function fakeGateway(rows) {
  const pageRows = PAGES.map(([hsr, url, title]) => ({ hsr, url, title }));
  return {
    async query(_sql, _params, label) {
      switch (label) {
        case 'sessions:entry': return rows;
        case 'site_hsr:resolve-pages':
        case 'urls:site-hsr-pages':
        case 'urls:site-hsr': return pageRows;
        case 'pageviews:page-hits': return [{ hits: 150 }];
        case 'site-baselines:second-pageview': return secondPages(rows);
        default: throw new Error(`unexpected query ${label}`);
      }
    },
  };
}

export function ctxFor(gateway) {
  return {
    ...WINDOW,
    batchId: 'b',
    gateway,
    batchNotes: new Map([[`bot:${IDSITE}`, Promise.resolve(BOT)]]),
    logger: { info() {}, warn() {} },
    datasets: new Map(),
  };
}

export const SITE = { idsite: IDSITE, siteName: 'x' };

export async function windowOutputs() {
  const rows = sessionRows();
  const ctx = () => ctxFor(fakeGateway(rows));
  const qualification = await preferNonHome.qualify(SITE, ctx());
  const targets = await defaultSix.select(SITE, qualification, ctx(), { maxPages: 6 });
  const page = { idsite: IDSITE, idsitehsr: qualification.idsitehsr, url: qualification.url, pageType: qualification.pageType };
  const channels = await entryByChannel.collect(page, ctx());
  const baselines = await siteBaselines.collect({ idsite: IDSITE, idsitehsr: 0, siteName: 'x' }, ctx());
  return { qualification, targets, channels, baselines };
}

/** The site-pass rows: the session row plus its second pageview's page. */
async function foldedRows() {
  const rows = sessionRows();
  const seconds = new Map(secondPages(rows).map((r) => [r.idvisit, r.hsr]));
  const plain = await fetchSessionRows(ctxFor(fakeGateway(rows)), IDSITE);
  return plain.map((s) => ({ ...s, secondHsr: seconds.get(s.idvisit) ?? null }));
}

/** Feeds a folder the rows reversed, in chunks of a day's worth or less. */
function foldInChunks(folder, rows) {
  const reversed = [...rows].reverse();
  for (let i = 0; i < reversed.length; i += 37) folder.fold(reversed.slice(i, i + 37));
  return folder;
}

describe('session reductions on the window path', () => {
  it('match the recorded outputs', async () => {
    expect(await windowOutputs()).toMatchSnapshot();
  });
});

describe('session folders', () => {
  it('give the window outputs when folded in pieces, in any order', async () => {
    const expected = await windowOutputs();
    const rows = await foldedRows();
    const ctx = () => ctxFor(fakeGateway(sessionRows()));

    const qualification = await foldInChunks(preferNonHome.open(SITE, ctx()), rows).finish(SITE, ctx());
    const targets = await foldInChunks(defaultSix.open(SITE, ctx()), rows).finish(SITE, qualification, ctx(), { maxPages: 6 });
    const channelFolder = foldInChunks(entryByChannel.open(SITE, ctx()), rows);
    const page = { idsite: IDSITE, idsitehsr: qualification.idsitehsr, url: qualification.url, pageType: qualification.pageType };
    const baselines = await foldInChunks(siteBaselines.open(SITE, ctx()), rows).finish({ idsite: IDSITE, idsitehsr: 0 }, ctx());

    expect({ qualification, targets, channels: await channelFolder.finish(page, ctx()), baselines }).toEqual(expected);
  });

  it('finish entry-by-channel per page from one fold, as collect does per page', async () => {
    const rows = await foldedRows();
    const folder = foldInChunks(entryByChannel.open(SITE, ctxFor(fakeGateway(sessionRows()))), rows);
    for (const idsitehsr of [11, 16, 18, 99]) {
      const page = { idsite: IDSITE, idsitehsr };
      const collected = await entryByChannel.collect(page, ctxFor(fakeGateway(sessionRows())));
      expect(await folder.finish(page, ctxFor(fakeGateway(sessionRows())))).toEqual(collected);
    }
  });

  it('read the session source in place of the window query', async () => {
    const rows = await foldedRows();
    const ctx = { ...ctxFor({ query: () => { throw new Error('no window query'); } }), sessionSource: { rows: async () => rows } };
    expect(await fetchSessionRows(ctx, IDSITE, { viewed: true })).toBe(rows);
  });
});
