import { describe, expect, it } from 'vitest';
import {
  LABELS, PATH_CONDITIONS, SHOPIFY, checkPageRules, createPageClassifier, pageClassSql,
} from '../../src/domain/page-class/index.js';
import {
  CHANNEL_TABLES, OPERATORS, VISIT_CHANNEL, channelSql, checkChannelTable, createChannelClassifier,
} from '../../src/domain/channel-rules/index.js';

describe('shared rule tables are read-only', () => {
  it('freezes the presets, labels, and channel tables all the way down', () => {
    expect(() => { SHOPIFY[0].when.push({ root: true }); }).toThrow(TypeError);
    expect(() => { LABELS.template.product = 'x'; }).toThrow(TypeError);
    expect(() => { VISIT_CHANNEL.rules[2].when.any[1].in.push('push'); }).toThrow(TypeError);
    expect(() => { CHANNEL_TABLES.link.fallback = 'x'; }).toThrow(TypeError);
  });
});

describe('one entry per condition kind', () => {
  it('every page-path kind has a value check, a JS test, and SQL', () => {
    for (const kind of Object.values(PATH_CONDITIONS)) {
      expect(Object.keys(kind).sort()).toEqual(['js', 'sql', 'value']);
    }
  });

  it('every channel operator has its field types, a value check, a JS test, and SQL', () => {
    for (const op of Object.values(OPERATORS)) {
      expect(Object.keys(op).sort()).toEqual(['check', 'js', 'sql', 'types']);
    }
  });
});

describe('classifiers check their rules when built', () => {
  it('stores page values lower-cased, so a raw rule matches like a resolved one', () => {
    const classify = createPageClassifier({ rules: [{ class: 'shop', when: [{ startsWith: '/Shop' }] }] });
    expect(classify('https://x.com/SHOP/a')).toBe('shop');
  });

  it('refuses a page pattern that does not compile, in JS and in SQL', () => {
    const rules = [{ class: 'bad', when: [{ match: '(' }] }];
    expect(() => checkPageRules(rules)).toThrow(/page rule "bad": match "\(" is not valid/);
    expect(() => createPageClassifier({ rules })).toThrow(/is not valid/);
    expect(() => pageClassSql('u', { rules })).toThrow(/is not valid/);
  });

  it('refuses channel values of the wrong shape, in JS and in SQL', () => {
    const empty = { rules: [{ channel: 'x', when: { field: 'utm_medium', in: [] } }], fallback: 'other' };
    expect(() => checkChannelTable(empty)).toThrow(/"in" needs a non-empty list/);
    expect(() => createChannelClassifier(empty)).toThrow(/"in" needs a non-empty list/);
    expect(() => channelSql(empty)).toThrow(/"in" needs a non-empty list/);
    const like = { rules: [{ channel: 'x', when: { field: 'source_or_referrer', like: 5 } }], fallback: 'other' };
    expect(() => channelSql(like)).toThrow(/"like" needs a string/);
    expect(() => channelSql({ rules: [] })).toThrow(/needs a fallback channel/);
  });
});
