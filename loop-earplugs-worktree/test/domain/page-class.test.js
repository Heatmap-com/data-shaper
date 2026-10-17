import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LABELS, createPageClassifier, normalizeUrl, pageClassSql, pathOf, resolvePageRules,
} from '../../src/domain/page-class/index.js';
import { hasClickHouseLocal, runLocal } from './clickhouse-local.js';

const snapshot = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/bundle/page-class.snapshot.json'), 'utf8',
));

const ESCAPED = {
  'https:\\/\\/sayiioficial.com\\/products\\/c\\u00f3ctel-capilar': 'product',
  'https:\\/\\/jormands.com.co\\/collections\\/promo': 'collection',
  'https:\\/\\/jormands.com.co\\/': 'home',
  'https:\\/\\/x.com\\/cart': 'cart',
  'https:\\/\\/x.com\\/pages\\/sobre-nosotros?x=1': 'content',
  'https:\\/\\/x.com\\/bad"quote\\/products\\/y': 'product',
};

const EDGE = [null, ' ', 'HTTPS://X.COM/PRODUCTS/Ñandú', 'https://x.com/a?b=https://y.com/products/z', 'https://x.com/x\\y', '/blogs', '/pages/'];

describe('normalizeUrl', () => {
  it('decodes JSON-escaped URLs and leaves plain ones alone', () => {
    expect(normalizeUrl('https:\\/\\/x.com\\/products\\/c\\u00f3ctel')).toBe('https://x.com/products/cóctel');
    expect(normalizeUrl('https://x.com/a')).toBe('https://x.com/a');
    expect(normalizeUrl(null)).toBe('');
  });

  it('turns \\/ into / when the body is not valid JSON', () => {
    expect(normalizeUrl('https:\\/\\/x.com\\/bad"quote')).toBe('https://x.com/bad"quote');
  });

  it('strips scheme, host, query, and fragment for the path', () => {
    expect(pathOf('https://www.x.com/Products/A?b=1#c')).toBe('/products/a');
    expect(pathOf('https://x.com')).toBe('');
    expect(pathOf('x.com/products/x')).toBe('x.com/products/x');
  });
});

describe('createPageClassifier', () => {
  it('matches the R0.1 page-type snapshot on every recorded URL', () => {
    const classify = createPageClassifier();
    const out = Object.fromEntries(Object.keys(snapshot).map((url) => [url, classify(url)]));
    expect(out).toEqual(snapshot);
  });

  it('classifies JSON-escaped URLs like their plain form', () => {
    const classify = createPageClassifier();
    for (const [url, expected] of Object.entries(ESCAPED)) expect(classify(url), url).toBe(expected);
  });

  it('applies a consumer label set', () => {
    const template = createPageClassifier({ labels: LABELS.template });
    expect(template('/products/a')).toBe('pdp');
    expect(template('/cart')).toBe('cart_page');
    expect(template('/pages/a')).toBe('unclassified');
    expect(template('')).toBe('unclassified');
    expect(createPageClassifier({ labels: LABELS.bundle })('/checkouts/c/1')).toBe('cart');
  });
});

describe('resolvePageRules', () => {
  it('prepends, removes, and appends site rules', () => {
    const rules = resolvePageRules({
      prepend: [{ class: 'private_sale', when: [{ startsWith: '/Private-Sale' }] }],
      remove: ['account'],
      append: [{ class: 'size_guide', when: [{ match: '^/size-?guide' }] }],
    });
    const classify = createPageClassifier({ rules });
    expect(classify('/private-sale/products/a')).toBe('private_sale');
    expect(classify('/account/login')).toBe('other');
    expect(classify('/SizeGuide')).toBe('size_guide');
  });

  it('rejects an unknown preset and a malformed condition', () => {
    expect(() => resolvePageRules({ preset: 'magento' })).toThrow(/unknown page-class preset "magento"/);
    expect(() => resolvePageRules({ prepend: [{ class: 'x', when: [{ prefix: '/x' }] }] })).toThrow(/a condition is one of/);
    expect(() => resolvePageRules({ prepend: [{ class: 'x', when: [] }] })).toThrow(/at least one condition/);
  });
});

describe.skipIf(!hasClickHouseLocal())('pageClassSql equals createPageClassifier in ClickHouse', () => {
  const urls = [...Object.keys(snapshot), ...Object.keys(ESCAPED), ...EDGE];
  const rules = resolvePageRules({
    prepend: [{ class: 'private_sale', when: [{ match: 'private-?sale' }] }],
  });

  for (const [name, labels] of Object.entries(LABELS)) {
    it(`agrees on every URL with the ${name} labels`, () => {
      const rows = runLocal('u Nullable(String)', urls.map((u) => ({ u })), `SELECT u, ${pageClassSql('u', { labels })} AS c FROM {table}`);
      const classify = createPageClassifier({ labels });
      expect(Object.fromEntries(rows.map((row, i) => [String(urls[i]), row.c]))).toEqual(Object.fromEntries(urls.map((u) => [String(u), classify(u)])));
    });
  }

  it('agrees with a site rule set', () => {
    const rows = runLocal('u Nullable(String)', urls.map((u) => ({ u })), `SELECT ${pageClassSql('u', { rules })} AS c FROM {table}`);
    const classify = createPageClassifier({ rules });
    expect(rows.map((row) => row.c)).toEqual(urls.map((u) => classify(u)));
  });
});
