import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverAdapters } from '../src/discover.js';

/**
 * The PageSelectorPort contract (src/ports/page-selector.js), run against
 * every discovered page selector: at maxPages 1 the selection is the
 * qualifier's page alone, as the primary target, with no queries.
 */

const QUALIFICATION = {
  status: 'qualified',
  idsitehsr: '222',
  url: 'https://shop.example/pages/lp',
  pageType: 'content',
  entrySessions: 500,
  orders: 4,
  revenue: 320.5,
  evidence: { title: 'LP' },
};

const PRIMARY = {
  idsitehsr: 222,
  url: 'https://shop.example/pages/lp',
  pageTitle: 'LP',
  pageType: 'content',
  role: 'primary',
  selectionReason: 'qualifier choice',
  entrySessions: 500,
  orders: 4,
  revenue: 320.5,
};

const selectors = await discoverAdapters(path.resolve('src/adapters/page-selectors'));
const noQueries = {
  gateway: {
    query() {
      throw new Error('a primary-only selection runs no query');
    },
  },
};

describe.each(selectors.map((selector) => [selector.id, selector]))('page selector %s', (_, selector) => {
  it('implements select', () => {
    expect(typeof selector.select).toBe('function');
  });

  it('selects the qualifier page as the primary target at maxPages 1', async () => {
    const site = { idsite: 7, siteName: 'Shop' };
    expect(await selector.select(site, QUALIFICATION, noQueries, { maxPages: 1 })).toEqual([PRIMARY]);
  });

  it('defaults missing qualification fields', async () => {
    const [target] = await selector.select({ idsite: 7, siteName: 'Shop' }, { status: 'qualified', idsitehsr: 9 }, noQueries, { maxPages: 1 });
    expect(target).toEqual({
      idsitehsr: 9,
      url: '',
      pageTitle: '',
      pageType: '',
      role: 'primary',
      selectionReason: 'qualifier choice',
      entrySessions: 0,
      orders: 0,
      revenue: 0,
    });
  });
});

it('discovers both shipped selectors', () => {
  expect(selectors.map((selector) => selector.id)).toEqual(['default-six', 'primary-only']);
});
