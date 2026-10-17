import { describe, expect, it } from 'vitest';
import { classifyTemplate } from '../../src/audit/classify.js';
import { templateMultiIf, templateRuleParams } from '../../src/audit/sql.js';
import { templateSql } from '../../src/enrichment/trend-sql.js';
import { createPageClassifier, LABELS } from '../../src/domain/page-class/index.js';
import { hasClickHouseLocal, runLocal } from './clickhouse-local.js';

const URLS = [
  '', 'https://x.com/', 'https://x.com/products/a', 'https://x.com/collections/b', 'https://x.com/cart/',
  'https://x.com/search/checkout', 'https://x.com/pages/a#b', 'https://x.com/account', 'https://x.com/shop/Bundles/12',
  'https://x.com/a-la-medida', 'https:\\/\\/x.com\\/products\\/c\\u00f3ctel', 'https://x.com/checkouts/c/1',
];
const BRAND = [{ pattern: '^/shop/bundles', template: 'bundle' }, { pattern: 'a-la-MEDIDA', template: 'custom' }];

describe.skipIf(!hasClickHouseLocal())('audit and trend SQL agree with their JS classifiers', () => {
  it('templateMultiIf with brand rules equals classifyTemplate', () => {
    const rows = runLocal('u String', URLS.map((u) => ({ u })), `SELECT ${templateMultiIf('u', BRAND)} AS t FROM {table}`, templateRuleParams(BRAND));
    expect(rows.map((row) => row.t)).toEqual(URLS.map((u) => classifyTemplate(u, BRAND)));
  });

  it('templateSql equals the classifier with trend labels', () => {
    const classify = createPageClassifier({ labels: LABELS.trend });
    const rows = runLocal('u String', URLS.map((u) => ({ u })), `SELECT ${templateSql('u')} AS t FROM {table}`);
    expect(rows.map((row) => row.t)).toEqual(URLS.map((u) => classify(u)));
  });
});
