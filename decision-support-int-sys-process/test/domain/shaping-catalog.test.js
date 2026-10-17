import { describe, expect, it } from 'vitest';
import { loadAttributeCatalog } from '../../src/catalog/attributes.js';
import { loadSourceKinds } from '../../src/catalog/sources.js';
import { checkCondition, foldCondition, predicateVisitor, sqlVisitor } from '../../src/domain/segmentation/conditions.js';
import { FIELDS } from '../../src/domain/segmentation/fields.js';
import { checkAttribute, conditionFields, visitAttributeSql } from '../../src/domain/shaping/attributes.js';
import { resolveMeasures } from '../../src/domain/shaping/measures.js';
import { checkRequest } from '../../src/domain/shaping/request.js';
import { checkSourceKind, keyValue, lookupTable, typedRows } from '../../src/domain/shaping/sources.js';
import { hasClickHouseLocal, runLocal } from './clickhouse-local.js';

const ATTRIBUTES = loadAttributeCatalog();
const KINDS = new Map(loadSourceKinds(ATTRIBUTES).map((kind) => [kind.id, kind]));
const visit = (doc) => checkAttribute({ id: 'tier', kind: 'visit', label: 'Tier', purpose: 'P', data: 'D', ...doc }, { fields: FIELDS, where: 'test' });

describe('attribute catalog', () => {
  it('ships every segmentation field as an attribute, and the visit and entry attributes', () => {
    const ids = ATTRIBUTES.map((attr) => attr.id);
    expect(ids).toEqual(expect.arrayContaining([...Object.keys(FIELDS), 'device', 'browser', 'city', 'region', 'operating_system', 'landing_template', 'landing_path', 'landing_page']));
    for (const attr of ATTRIBUTES.filter((a) => a.kind === 'field')) expect(attr.type).toBe(FIELDS[attr.id].type);
    expect(ATTRIBUTES.find((a) => a.id === 'landing_path')).toMatchObject({ kind: 'entry', type: 'string', needs: ['entry'], inQuery: true });
  });

  it('refuses a declaration the query could not compute', () => {
    expect(() => visit({ column: 'password', type: 'string' })).toThrow(/column must be one of/);
    expect(() => visit({ column: 'custom_var_v2', type: 'string', normalize: ['upper'] })).toThrow(/normalize must be/);
    expect(() => visit({ column: 'visitor_returning', type: 'string' })).toThrow(/is a flag/);
    expect(() => visit({ column: 'custom_var_v2', type: 'string', labels: { 1: 'a' } })).toThrow(/labels name the codes of a whole-number column/);
    expect(() => visit({ column: 'custom_var_v2', type: 'string', sql: 'x' })).toThrow(/unknown key "sql"/);
    expect(() => checkAttribute({ id: 'nope', kind: 'field', label: 'L', purpose: 'P', data: 'D' }, { fields: FIELDS, where: 'test' })).toThrow(/not a registered segmentation field/);
    expect(() => checkAttribute({ id: 'x', kind: 'entry', label: 'L', purpose: 'P', data: 'D', property: 'title' }, { fields: FIELDS, kinds: ['visit'], where: 'site' })).toThrow(/kind must be one of visit/);
  });

  it('gives conditions only the attributes the query computes', () => {
    const fields = conditionFields([...ATTRIBUTES, { id: 'site_catalog.product_type', kind: 'lookup', type: 'string', data: 'D', needs: [], inQuery: false }]);
    expect(fields.landing_path).toMatchObject({ type: 'string', needs: 'entry' });
    expect(fields['site_catalog.product_type']).toBeUndefined();
  });
});

describe.skipIf(!hasClickHouseLocal())('visitAttributeSql', () => {
  const rows = [
    { t: '2026-09-01 10:00:00', s: '  Gold ', n: 3, f: true, num: ' 12.5' },
    { t: '2026-09-01 09:00:00', s: null, n: null, f: null, num: null },
    { t: '2026-09-01 11:00:00', s: 'Silver', n: 1, f: false, num: '4' },
  ];
  const structure = 's Nullable(String), n Nullable(UInt8), f Nullable(Bool), num Nullable(String), t String';
  const run = (attr, column) => runLocal(structure, rows, `SELECT ${visitAttributeSql({ ...attr, column })} AS v FROM (SELECT s AS custom_var_v2, n AS config_device_type, f AS visitor_returning, num AS custom_var_v3, t AS visit_first_action_time FROM table)`)[0].v;

  it('is never null, and picks, normalizes, and labels as declared', () => {
    expect(run(visit({ column: 'custom_var_v2', type: 'string' }), 'custom_var_v2')).toBe('  Gold ');
    expect(runLocal('s Nullable(String), t String', [{ s: null, t: 'a' }], `SELECT ${visitAttributeSql(visit({ column: 'custom_var_v2', type: 'string' }))} AS v FROM (SELECT s AS custom_var_v2, t AS visit_first_action_time FROM table)`)[0].v).toBe('');
    expect(run(visit({ column: 'custom_var_v2', type: 'string', pick: 'last', normalize: ['trim', 'lower'] }), 'custom_var_v2')).toBe('silver');
    expect(run(visit({ column: 'custom_var_v2', type: 'string', pick: 'max', normalize: ['trim'] }), 'custom_var_v2')).toBe('Silver');
    expect(run(visit({ column: 'config_device_type', type: 'string', pick: 'max', labels: { 1: 'desktop', 3: 'mobile' } }), 'config_device_type')).toBe('mobile');
    expect(run(visit({ column: 'config_device_type', type: 'string', labels: { 1: 'desktop' }, otherwise: 'other' }), 'config_device_type')).toBe('other');
    expect(Number(run(visit({ column: 'visitor_returning', type: 'number', pick: 'last' }), 'visitor_returning'))).toBe(0);
    expect(Number(run(visit({ column: 'custom_var_v3', type: 'number', pick: 'max' }), 'custom_var_v3'))).toBe(4);
  });
});

describe('number operators', () => {
  const vocabulary = { fields: { visits: { type: 'number', source: 'x' }, tier: { type: 'string', source: 'x' } }, lists: {}, bases: {} };

  it('compare numbers in SQL and JavaScript alike', () => {
    const condition = { all: [{ field: 'visits', gte: 2 }, { field: 'visits', lt: 5 }] };
    checkCondition(condition, vocabulary, 'test');
    const test = foldCondition(condition, predicateVisitor(vocabulary.fields));
    expect([1, 2, 4, 5].map((visits) => test({ visits }))).toEqual([false, true, true, false]);
    expect(foldCondition(condition, sqlVisitor())).toBe('(visits >= 2 AND visits < 5)');
  });

  it('refuse a string field or a value that is not a number', () => {
    expect(() => checkCondition({ field: 'tier', gt: 1 }, vocabulary, 'test')).toThrow();
    expect(() => checkCondition({ field: 'visits', gt: '1' }, vocabulary, 'test')).toThrow();
  });
});

describe('source kinds', () => {
  it('ship Meta Ads, GA4, and a site catalog over shipped attributes', () => {
    expect([...KINDS.keys()].sort()).toEqual(['ga4', 'meta_ads', 'site_catalog']);
    expect(KINDS.get('meta_ads').keys.map((key) => key.attribute)).toEqual(['utm_campaign']);
    expect(KINDS.get('site_catalog')).toMatchObject({ role: 'lookup', key: { attribute: 'landing_path' }, fallback: '(unmatched)' });
  });

  it('map a source spelling onto the attribute value', () => {
    const [source, medium] = KINDS.get('ga4').keys;
    expect(keyValue(source, ' Google ')).toBe('google');
    expect(keyValue(source, '(direct)')).toBe('');
    expect(keyValue(medium, 'organic')).toBe('');
    expect(keyValue(KINDS.get('meta_ads').keys[0], ' Fall_Sale ')).toBe('Fall_Sale');
  });

  it('type rows and count the ones that do not fit', () => {
    const typed = typedRows(KINDS.get('meta_ads'), [
      { date: '2026-09-01', campaign_name: 'a', spend: '12.5' },
      { date: '09/01/2026', campaign_name: 'b', spend: 1 },
      { date: '2026-09-02', campaign_name: 'c', spend: 'n/a' },
    ]);
    expect(typed.rows).toEqual([{ date: '2026-09-01', campaign_id: '', campaign_name: 'a', spend: 12.5, impressions: 0, clicks: 0, purchases: 0, purchase_value: 0 }]);
    expect(typed.rejected).toBe(2);
    expect(typed.examples).toEqual(['row 2: date "09/01/2026" is not a day', 'row 3: spend "n/a" is not a number']);
  });

  it('build a lookup table on the key, first row winning', () => {
    const kind = KINDS.get('site_catalog');
    const { table, conflicts } = lookupTable(kind, [
      { path: '/Products/A ', product_type: 'shirts', collection: 'summer', price_band: '50-100' },
      { path: '/products/a', product_type: 'coats', collection: 'fall', price_band: '200+' },
    ]);
    expect(table.get('/products/a')).toEqual({ product_type: 'shirts', collection: 'summer', price_band: '50-100' });
    expect(conflicts).toBe(1);
  });

  it('refuse a kind that does not hold together', () => {
    const base = { id: 'x', label: 'L', purpose: 'P', data: 'D', role: 'facts', grain: 'day', columns: { date: 'date', name: 'string', spend: 'number' }, keys: [], measures: { spend: { label: 'S', data: 'D' } } };
    expect(checkSourceKind(base, 't')).toMatchObject({ id: 'x', role: 'facts' });
    expect(() => checkSourceKind({ ...base, grain: 'hour' }, 't')).toThrow(/grain must be day/);
    expect(() => checkSourceKind({ ...base, measures: { name: { label: 'N', data: 'D' } } }, 't')).toThrow(/measures.name must be a number column/);
    expect(() => checkSourceKind({ ...base, keys: [{ column: 'spend', attribute: 'utm_campaign' }] }, 't')).toThrow(/must be a string column/);
    expect(() => checkSourceKind({ ...base, sql: 'SELECT 1' }, 't')).toThrow(/unknown key "sql"/);
  });
});

describe('resolveMeasures', () => {
  const resolve = (request) => resolveMeasures({ derived: [], ...request }, KINDS);

  it('resolves session, source, and derived measures, and what they divide', () => {
    const out = resolve({ measures: ['sessions', 'meta_ads.spend', 'roas', 'aov'], derived: [{ id: 'roas', label: 'ROAS', data: 'D', ratio: ['revenue', 'meta_ads.spend'] }] });
    expect(out.problems).toEqual([]);
    expect(out.output).toEqual(['sessions', 'meta_ads.spend', 'roas', 'aov']);
    expect(out.additive.sort()).toEqual(['meta_ads.spend', 'orders', 'revenue', 'sessions']);
    expect(out.sources).toEqual(['meta_ads']);
  });

  it('names what it does not know, and refuses a ratio of ratios', () => {
    const out = resolve({ measures: ['bounce_rate', 'tiktok.spend', 'meta_ads.reach', 'x'], derived: [{ id: 'x', label: 'X', data: 'D', ratio: ['aov', 'sessions'] }] });
    expect(out.unknown.map((entry) => entry.name)).toEqual(['bounce_rate', 'tiktok.spend', 'meta_ads.reach']);
    expect(out.problems).toEqual([expect.stringMatching(/derived x: aov is not an additive measure/)]);
  });

  it('reads the rank and floor measures without reporting them', () => {
    const out = resolve({ measures: ['conversion_rate'], rankBy: 'revenue', floor: { sessions: 30 } });
    expect(out.output).toEqual(['conversion_rate']);
    expect(out.measures.map((m) => m.id).sort()).toEqual(['buyers', 'conversion_rate', 'revenue', 'sessions']);
  });
});

describe('checkRequest', () => {
  const base = { id: 'q', question: 'Q?', idsite: 7, window: { start: '2026-09-01', end: '2026-09-30' }, measures: ['sessions'] };

  it('fills defaults', () => {
    expect(checkRequest(base).request).toMatchObject({ subject: 'sessions', by: [], segmentations: [], filter: null, rank: null, floor: {}, sources: {}, period: { grain: 'week' } });
  });

  it('reports what the requester must fix', () => {
    const { problems } = checkRequest({ ...base, id: 'Q 1', by: ['a', 'a', 'b', 'c'], measures: [], rank: { by: 'sessions', limit: 0 }, sources: { meta_ads: { partial: 'maybe' } }, sql: 'x' });
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/unknown key "sql"/),
      'id must match ^[a-z][a-z0-9_]*$',
      'by has 4 entries; at most 3',
      'by names an attribute twice',
      'measures must name at least one measure',
      'rank.limit is a whole number from 1 to 1000',
      'sources.meta_ads is { partial: refuse | allow }',
    ]));
  });

  it('separates an ask the engine has no vocabulary for', () => {
    expect(checkRequest({ ...base, subject: 'products' })).toMatchObject({ problems: [], unknownSubject: 'products' });
    expect(checkRequest({ ...base, period: { grain: 'cohort' } })).toMatchObject({ problems: [], unknownGrain: 'cohort' });
  });
});
