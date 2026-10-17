import { describe, expect, it } from 'vitest';
import { focusPath, resolveFocus } from '../src/orchestrator/domain/bundle-focus.js';

describe('bundle focus', () => {
  it('keeps the site root as /', () => {
    expect(focusPath('https://frankandeileen.com/')).toBe('/');
  });

  it('drops a trailing slash from a page path', () => {
    expect(focusPath('https://loopearplugs.com/pages/lp-homepage-lp2/')).toBe('/pages/lp-homepage-lp2');
  });

  it('returns an existing focus when the page argument is null', () => {
    const existing = { path: '/pages/lp-homepage-lp2', label: 'LP', idsitehsr: 17315997 };
    expect(resolveFocus(existing, null)).toEqual(existing);
  });

  it('throws the blocked sentence when focus and the primary page are both missing', () => {
    expect(() => resolveFocus(undefined, null)).toThrow('site.json has no focus and the analysis batch has no primary page');
  });

  it('rejects an idsitehsr that is not an integer', () => {
    expect(() => resolveFocus(undefined, { idsitehsr: 17315997.5, url: 'https://loopearplugs.com/' })).toThrow(
      'site.json has no focus and the analysis batch has no primary page',
    );
  });
});
