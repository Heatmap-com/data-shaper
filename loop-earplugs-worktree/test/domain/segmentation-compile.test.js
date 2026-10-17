import { describe, expect, it } from 'vitest';
import { loadSegmentationCatalog } from '../../src/catalog/segmentations.js';
import {
  FIELDS, SEGMENTATION_VOCABULARY as SEGMENTATION_REGISTRY, applyOverride, checkDeclaration, foldCondition, segmentationClassifier, segmentationSql, segmentationStamp,
} from '../../src/domain/segmentation/index.js';
import { hasClickHouseLocal, runLocal } from './clickhouse-local.js';

const catalog = new Map(loadSegmentationCatalog().map((seg) => [seg.id, seg]));
const doc = (extra = {}) => ({
  id: 'device_mix', label: 'L', purpose: 'P', data: 'D',
  rules: [{ value: 'paid', when: { field: 'utm_medium', in: '@paid_mediums' } }], fallback: 'unpaid', ...extra,
});
const check = (d) => () => checkDeclaration(d, SEGMENTATION_REGISTRY, 'sites/x');

describe('the shipped catalog', () => {
  it('loads every shipped segmentation with its values in order', () => {
    expect([...catalog.keys()]).toEqual(['buyer', 'channel', 'link_channel', 'rager', 'returning', 'traffic_source']);
    expect(catalog.get('traffic_source').values).toEqual(['meta', 'direct', 'search', 'website', 'campaign', 'social', 'other']);
    expect(catalog.get('returning').values).toEqual(['returning', 'new']);
    expect(catalog.get('buyer').values).toEqual(['buyer', 'non_buyer']);
    expect(catalog.get('rager').values).toEqual(['rager', 'non_rager']);
    expect(catalog.get('channel').values).toEqual(['direct', 'search', 'email_sms', 'meta_paid', 'meta_untagged', 'affiliate', 'other']);
    expect(catalog.get('link_channel').values).toEqual([
      'automated_email_flow', 'affiliate', 'google_ads', 'campaign_email_sms', 'meta', 'meta_no_link', 'no_campaign_link', 'other_tagged',
    ]);
  });

  it('records the fields and shared CTEs each one reads', () => {
    expect(catalog.get('traffic_source').fields).toEqual(['utm_source', 'referer_type']);
    expect(catalog.get('buyer').needs).toEqual(['orders']);
    expect(catalog.get('rager').needs).toEqual(['ragers']);
    expect(catalog.get('channel').needs).toEqual([]);
    expect(catalog.get('link_channel').fields).toEqual(['utm_medium', 'source_or_referrer', 'utm_campaign']);
  });

  it('resolves lists, so the stamp moves with a list and the SQL reads its values', () => {
    expect(catalog.get('traffic_source').rules[0].when).toEqual({ field: 'utm_source', in: ['facebook', 'ig', 'fb', 'instagram', 'facebookads'] });
    expect(segmentationStamp(catalog.get('returning'))).toBe('{"fallback":"new","rules":[{"value":"returning","when":{"eq":1,"field":"returning"}}]}');
    expect(() => { catalog.get('channel').rules[0].when.eq = 9; }).toThrow(TypeError);
  });
});

describe('checkDeclaration', () => {
  it('names each mistake with the file and the segmentation', () => {
    expect(check(doc({ id: 'All' }))).toThrow(/sites\/x: segmentation All: id must match/);
    expect(check(doc({ id: 'all' }))).toThrow(/id must match/);
    expect(check(doc({ purpose: ' ' }))).toThrow(/purpose must be a non-empty string/);
    expect(check(doc({ base: 'visit' }))).toThrow(/exactly one of rules or base/);
    expect(check(doc({ extra: 1 }))).toThrow(/unknown key "extra"/);
    expect(check(doc({ base: 'ads', rules: undefined }))).toThrow(/unknown base "ads"/);
    expect(check(doc({ prepend: [] }))).toThrow(/prepend needs a base/);
    expect(check(doc({ fallback: undefined }))).toThrow(/fallback must be a value/);
    expect(check(doc({ fallback: 'all' }))).toThrow(/fallback must be a value/);
    expect(check(doc({ rules: [] }))).toThrow(/at least one rule/);
    expect(check(doc({ rules: [{ value: 'Paid', when: { field: 'utm_medium', eq: 'paid' } }] }))).toThrow(/rule value "Paid"/);
    expect(check(doc({ rules: [{ value: 'paid', when: { field: 'medium', eq: 'paid' } }] }))).toThrow(/device_mix "paid": unknown field "medium"/);
    expect(check(doc({ rules: [{ value: 'x', when: { field: 'returning', eq: 1 } }], fallback: 'x' }))).toThrow(/has 1 values/);
    const many = Array.from({ length: 16 }, (_, i) => ({ value: `v${i}`, when: { field: 'referer_type', eq: i } }));
    expect(check(doc({ rules: many }))).toThrow(/has 17 values; a segmentation has 2 to 16/);
  });

  it('builds a base table with its adjustments', () => {
    const seg = checkDeclaration({
      id: 'channel_paid', label: 'L', purpose: 'P', data: 'D', base: 'visit', remove: ['affiliate'],
      prepend: [{ value: 'google_paid', when: { all: [{ field: 'referer_type', in: [2, 6] }, { field: 'utm_medium', eq: 'cpc' }] } }],
    }, SEGMENTATION_REGISTRY, 'sites/x');
    expect(seg.values).toEqual(['google_paid', 'direct', 'search', 'email_sms', 'meta_paid', 'meta_untagged', 'other']);
    expect(check({ id: 'c', label: 'L', purpose: 'P', data: 'D', base: 'visit', remove: ['tiktok'] })).toThrow(/remove names values no rule has: tiktok/);
  });
});

describe('applyOverride', () => {
  it('prepends, removes, and renames the fallback, then checks again', () => {
    const seg = applyOverride(catalog.get('channel'), {
      prepend: [{ value: 'tiktok', when: { field: 'referer_name', eq: 'tiktok' } }], remove: ['affiliate'], fallback: 'rest',
    }, SEGMENTATION_REGISTRY, 'sites/dvf');
    expect(seg.values).toEqual(['tiktok', 'direct', 'search', 'email_sms', 'meta_paid', 'meta_untagged', 'rest']);
    expect(segmentationClassifier(seg)({ referer_type: 3, referer_name: 'shopmy' })).toBe('rest');
    expect(() => applyOverride(catalog.get('channel'), { rules: [] }, SEGMENTATION_REGISTRY, 'sites/dvf')).toThrow(/sites\/dvf: override of channel: unknown key "rules"/);
    expect(() => applyOverride(catalog.get('channel'), { prepend: [{ value: 'x', when: { field: 'referer_type', eq: 'a' } }] }, SEGMENTATION_REGISTRY, 'sites/dvf'))
      .toThrow(/is a number/);
  });
});

describe('segmentationSql', () => {
  it('refuses a field the query does not map', () => {
    expect(() => segmentationSql(catalog.get('traffic_source'), { utm_source: 'k.utm_source' }))
      .toThrow(/segmentation traffic_source: field "referer_type" has no column/);
  });
});

/** Values that reach each branch of a field's conditions, plus null and a miss. */
function edges(seg) {
  /** @type {Map<string, Set<unknown>>} */
  const byField = new Map(seg.fields.map((field) => [field, new Set([null, FIELDS[field].type === 'number' ? 0 : '', FIELDS[field].type === 'number' ? 99 : 'zz'])]));
  const leaf = (field, op, value) => {
    const set = byField.get(field);
    if (op === 'in') for (const item of value) set.add(item);
    else if (op === 'like') set.add(String(value).replaceAll('%', 'x').replaceAll('_', 'y'));
    else if (op === 'startsWith') set.add(`${value}x`);
    else set.add(value);
  };
  for (const rule of seg.rules) foldCondition(rule.when, { any: () => null, all: () => null, leaf });
  return byField;
}

function grid(byField) {
  let rows = [{}];
  for (const [field, values] of byField) rows = rows.flatMap((row) => [...values].map((value) => ({ ...row, [field]: value })));
  return rows;
}

describe.skipIf(!hasClickHouseLocal())('the shipped declarations in ClickHouse', () => {
  it('equal their JavaScript twins on every edge of every field, nulls included', () => {
    for (const seg of catalog.values()) {
      const byField = edges(seg);
      const rows = grid(byField);
      const structure = seg.fields.map((field) => `${field} Nullable(${FIELDS[field].type === 'number' ? 'Int32' : 'String'})`).join(', ');
      const columns = Object.fromEntries(seg.fields.map((field) => [field, `ifNull(${field}, ${FIELDS[field].type === 'number' ? '0' : "''"})`]));
      const out = runLocal(structure, rows, `SELECT ${segmentationSql(seg, columns)} AS v FROM {table}`);
      const classify = segmentationClassifier(seg);
      expect(out.map((row) => row.v), seg.id).toEqual(rows.map((row) => classify(row)));
    }
  });

  it('equal the trend expressions they replace', () => {
    const rows = [];
    for (const utm of ['facebook', 'ig', 'fb', 'instagram', 'facebookads', 'igshopping', 'klaviyo', '', null]) {
      for (const rt of [0, 1, 2, 3, 4, 5, 6, 7, 8, null]) {
        for (const returning of [0, 1, null]) {
          for (const orders of [null, 0, 1, 3]) {
            for (const rager of [0, 7, null]) rows.push({ utm_source: utm, referer_type: rt, returning, orders, r_idvisit: rager, idvisit: 7 });
          }
        }
      }
    }
    const traffic = `multiIf(
    k.utm_source IN ('facebook', 'ig', 'fb', 'instagram', 'facebookads'), 'meta',
    k.referer_type = 1, 'direct',
    k.referer_type = 2, 'search',
    k.referer_type = 3, 'website',
    k.referer_type = 6, 'campaign',
    k.referer_type = 7, 'social',
    'other')`;
    const columns = {
      utm_source: "ifNull(k.utm_source, '')",
      referer_type: 'ifNull(k.referer_type, 0)',
      returning: 'ifNull(k.returning, 0)',
      has_order: 'toUInt8(ifNull(k.orders, 0) > 0)',
      has_rage_click: 'ifNull(toUInt8(k.r_idvisit = k.idvisit), 0)',
    };
    const out = runLocal(
      'utm_source Nullable(String), referer_type Nullable(Int32), returning Nullable(UInt8), orders Nullable(UInt32), r_idvisit Nullable(UInt64), idvisit UInt64',
      rows,
      `SELECT ${traffic} AS old_traffic, ${segmentationSql(catalog.get('traffic_source'), columns)} AS new_traffic,
              if(k.returning = 1, 'returning', 'new') AS old_returning, ${segmentationSql(catalog.get('returning'), columns)} AS new_returning,
              if(ifNull(k.orders, 0) > 0, 'buyer', 'non_buyer') AS old_buyer, ${segmentationSql(catalog.get('buyer'), columns)} AS new_buyer,
              if(k.r_idvisit = k.idvisit, 'rager', 'non_rager') AS old_rager, ${segmentationSql(catalog.get('rager'), columns)} AS new_rager
       FROM {table} AS k`,
    );
    expect(out).toHaveLength(rows.length);
    for (const name of ['traffic', 'returning', 'buyer', 'rager']) {
      expect(out.map((row) => row[`new_${name}`]), name).toEqual(out.map((row) => row[`old_${name}`]));
    }
  });
});
