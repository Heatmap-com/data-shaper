import { describe, expect, it } from 'vitest';
import { resolvePages, unitsFor } from '../../../src/orchestrator/domain/pages.js';

const site = {
  slug: 'sayii',
  domain: 'sayii.com',
  origin: 'https://sayii.com',
  pages: { include: [{ url: 'https://sayii.com/', role: 'home' }, { url: 'https://sayii.com/cart', role: 'cart' }] },
};

describe('resolvePages', () => {
  it('lets CLI pages win over everything', () => {
    expect(resolvePages({ cliPages: ['https://sayii.com/a'], runPages: { source: 'site' }, site }))
      .toEqual([{ url: 'https://sayii.com/a' }]);
  });

  it('uses the site collection when the source is site', () => {
    expect(resolvePages({ runPages: { source: 'site', fallback: 'home' }, site })).toEqual(site.pages.include);
  });

  it('uses the origin alone when the source is qualifier', () => {
    expect(resolvePages({ runPages: { source: 'qualifier' }, site }))
      .toEqual([{ url: 'https://sayii.com', role: 'home' }]);
  });

  it('falls back to the home page when the site has no collection', () => {
    const bare = { ...site, pages: undefined };
    expect(resolvePages({ runPages: { source: 'site', fallback: 'home' }, site: bare }))
      .toEqual([{ url: 'https://sayii.com', role: 'home' }]);
  });

  it('defaults to the site source with a home fallback when the run says nothing', () => {
    expect(resolvePages({ site })).toEqual(site.pages.include);
    const bare = { ...site, pages: undefined };
    expect(resolvePages({ site: bare })).toEqual([{ url: 'https://sayii.com', role: 'home' }]);
  });

  it('returns no pages when the fallback is none', () => {
    const bare = { ...site, pages: undefined };
    expect(resolvePages({ runPages: { source: 'site', fallback: 'none' }, site: bare })).toEqual([]);
  });
});

describe('unitsFor', () => {
  it('is one unit per page for forEach: pages', () => {
    const job = { pages: site.pages.include };
    expect(unitsFor({ forEach: 'pages' }, job)).toEqual([
      { key: 'https://sayii.com/', page: site.pages.include[0] },
      { key: 'https://sayii.com/cart', page: site.pages.include[1] },
    ]);
  });

  it('is a single site unit otherwise', () => {
    expect(unitsFor({}, { pages: site.pages.include })).toEqual([{ key: 'site' }]);
  });
});
