import { describe, expect, it } from 'vitest';
import { canonical } from '../../src/domain/canonical.js';
import {
  checkCondition, fieldsOf, foldCondition, predicateVisitor, resolveLists, sqlVisitor,
} from '../../src/domain/segmentation/conditions.js';
import { FIELDS } from '../../src/domain/segmentation/fields.js';
import { LISTS } from '../../src/domain/segmentation/lists.js';
import { canonical as triggerCanonical } from '../../src/triggers/definitions.js';

const VOCABULARY = { fields: FIELDS, lists: LISTS };
const check = (condition) => () => checkCondition(condition, VOCABULARY, 'traffic_source "meta"');

describe('typed condition checks', () => {
  it('accepts a registered field with a value of its type, and a list reference', () => {
    expect(check({ field: 'referer_type', in: [1, 2] })).not.toThrow();
    expect(check({ field: 'utm_source', in: '@meta_utm_sources_trend' })).not.toThrow();
    expect(check({ all: [{ field: 'utm_medium', like: '%paid%' }, { field: 'has_order', eq: 1 }] })).not.toThrow();
  });

  it('names the owner and the problem for each kind of mistake', () => {
    expect(check({ field: 'device', eq: 1 })).toThrow(/traffic_source "meta": unknown field "device"/);
    expect(check({ field: 'referer_type', like: '1%' })).toThrow(/"like" does not apply to number field "referer_type"/);
    expect(check({ field: 'utm_source', eq: 1 })).toThrow(/field "utm_source" is a string, got 1/);
    expect(check({ field: 'referer_type', in: ['1'] })).toThrow(/field "referer_type" is a number, got "1"/);
    expect(check({ field: 'utm_source', in: '@tiktok' })).toThrow(/unknown list @tiktok \(@meta_utm_sources_trend/);
    expect(check({ field: 'referer_type', in: '@meta_referers' })).toThrow(/is a number, got "facebook"/);
    expect(check({ any: [] })).toThrow(/any\/all needs a non-empty list/);
    expect(check({ any: [{ field: 'returning', eq: 1 }], all: [{ field: 'returning', eq: 0 }] })).toThrow(/any or all, not both/);
    expect(check({ field: 'utm_source', eq: 'a', ne: 'b' })).toThrow(/a condition is/);
  });

  it('checks only shape and values without a vocabulary', () => {
    expect(() => checkCondition({ field: 'anything', eq: 1 }, null, 'x')).not.toThrow();
    expect(() => checkCondition({ field: 'x', in: '@meta_referers' }, null, 'x')).toThrow(/needs the list registry/);
  });
});

describe('lists, fields, and defaults', () => {
  it('replaces every list reference with a copy of its values', () => {
    const resolved = resolveLists({ any: [{ field: 'referer_name', in: '@meta_referers' }, { field: 'utm_medium', eq: 'paid' }] }, LISTS);
    expect(resolved).toEqual({ any: [{ field: 'referer_name', in: ['facebook', 'instagram'] }, { field: 'utm_medium', eq: 'paid' }] });
    expect(Object.isFrozen(resolved.any[0].in)).toBe(false);
  });

  it('lists the fields a condition reads once each, in order', () => {
    expect(fieldsOf({ any: [{ field: 'utm_source', eq: 'a' }, { all: [{ field: 'referer_type', eq: 1 }, { field: 'utm_source', eq: 'b' }] }] }))
      .toEqual(['utm_source', 'referer_type']);
  });

  it('reads a missing value as the field type default', () => {
    const test = foldCondition({ field: 'referer_type', ne: 1 }, predicateVisitor(FIELDS));
    expect(test({ referer_type: null })).toBe(true);
    const zero = foldCondition({ field: 'has_order', eq: 0 }, predicateVisitor(FIELDS));
    expect(zero({})).toBe(true);
    const blank = foldCondition({ field: 'utm_campaign', eq: '' }, predicateVisitor(FIELDS));
    expect(blank({ utm_campaign: undefined })).toBe(true);
  });

  it('builds SQL only over the columns the query maps', () => {
    const condition = { all: [{ field: 'referer_type', eq: 3 }, { field: 'utm_medium', in: ['paid'] }] };
    expect(foldCondition(condition, sqlVisitor({ referer_type: 'k.referer_type', utm_medium: 'k.utm_medium' })))
      .toBe("(k.referer_type = 3 AND k.utm_medium IN ('paid'))");
    expect(() => foldCondition(condition, sqlVisitor({ referer_type: 'k.referer_type' }, 'channel "x"')))
      .toThrow(/channel "x": field "utm_medium" has no column/);
  });

  it('freezes the registries, and every number field names what its 1 means', () => {
    expect(() => { FIELDS.utm_source.type = 'number'; }).toThrow(TypeError);
    expect(() => { LISTS.meta_referers.push('x'); }).toThrow(TypeError);
    for (const spec of Object.values(FIELDS)) {
      expect(['string', 'number']).toContain(spec.type);
      expect(spec.source).toBeTruthy();
    }
  });

  it('keeps one canonical form for the triggers and the segmentations', () => {
    expect(triggerCanonical).toBe(canonical);
    expect(canonical({ b: [2, { d: 1, c: 0 }], a: 'x' })).toBe('{"a":"x","b":[2,{"c":0,"d":1}]}');
  });
});
