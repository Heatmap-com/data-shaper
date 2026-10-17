import { describe, expect, it } from 'vitest';
import {
  LINK_CHANNEL, VISIT_CHANNEL, channelSql, createChannelClassifier, resolveChannelRules,
} from '../../src/domain/channel-rules/index.js';
import { hasClickHouseLocal, runLocal } from './clickhouse-local.js';

const visit = createChannelClassifier(VISIT_CHANNEL);
const link = createChannelClassifier(LINK_CHANNEL);

describe('visit channel', () => {
  it('reads referer type first, then the email, Meta, and affiliate rules', () => {
    expect(visit({ referer_type: 1, referer_name: 'klaviyo', utm_medium: 'email' })).toBe('direct');
    expect(visit({ referer_type: 2 })).toBe('search');
    expect(visit({ referer_type: 3, referer_name: 'cart-abandon-flow', utm_medium: '' })).toBe('email_sms');
    expect(visit({ referer_type: 3, referer_name: 'facebook', utm_medium: 'paid' })).toBe('meta_paid');
    expect(visit({ referer_type: 3, referer_name: 'instagram', utm_medium: '' })).toBe('meta_untagged');
    expect(visit({ referer_type: 3, referer_name: 'shopmy', utm_medium: '' })).toBe('affiliate');
    expect(visit({ referer_type: 3, referer_name: 'google', utm_medium: 'organic' })).toBe('other');
  });

  it('reads a missing field as its type default', () => {
    expect(visit({ referer_type: null, referer_name: null, utm_medium: null })).toBe('other');
    expect(visit({})).toBe('other');
  });
});

describe('link channel', () => {
  it('splits Meta by whether the link carried a medium or campaign', () => {
    expect(link({ source_or_referrer: 'ig', utm_medium: 'paid', utm_campaign: '' })).toBe('meta');
    expect(link({ source_or_referrer: 'ig', utm_medium: '', utm_campaign: '' })).toBe('meta_no_link');
    expect(link({ source_or_referrer: '', utm_medium: '', utm_campaign: '' })).toBe('no_campaign_link');
    expect(link({ source_or_referrer: 'ran_123', utm_medium: '', utm_campaign: '' })).toBe('affiliate');
    expect(link({ source_or_referrer: 'newsletter', utm_medium: 'x', utm_campaign: '' })).toBe('other_tagged');
  });
});

describe('resolveChannelRules', () => {
  it('lets a site add and drop channels', () => {
    const table = resolveChannelRules('visit', { prepend: [{ channel: 'tiktok', when: { field: 'referer_name', eq: 'tiktok' } }], remove: ['affiliate'] });
    const classify = createChannelClassifier(table);
    expect(classify({ referer_type: 3, referer_name: 'tiktok' })).toBe('tiktok');
    expect(classify({ referer_type: 3, referer_name: 'shopmy' })).toBe('other');
  });

  it('rejects malformed rules', () => {
    expect(() => resolveChannelRules('ads')).toThrow(/unknown channel table/);
    expect(() => resolveChannelRules('link', { prepend: [{ channel: 'x', when: { field: 'utm_source', regex: 'a' } }] })).toThrow(/a condition is/);
    expect(() => resolveChannelRules('link', { prepend: [{ channel: 'x', when: { any: [] } }] })).toThrow(/non-empty list/);
  });

  it('refuses an unregistered field, a wrong type, and an unknown list', () => {
    expect(() => channelSql({ rules: [{ channel: 'x', when: { field: 'a); DROP', eq: 1 } }], fallback: 'o' })).toThrow(/unknown field "a\); DROP"/);
    expect(() => resolveChannelRules('visit', { prepend: [{ channel: 'x', when: { field: 'referer_type', eq: '1' } }] })).toThrow(/is a number/);
    expect(() => resolveChannelRules('visit', { prepend: [{ channel: 'x', when: { field: 'referer_name', in: '@tiktok' } }] })).toThrow(/unknown list @tiktok/);
  });

  it('refuses a field the query has no column for', () => {
    expect(() => channelSql(VISIT_CHANNEL, { referer_type: 'rt' })).toThrow(/field "referer_name" has no column/);
  });
});

describe.skipIf(!hasClickHouseLocal())('channelSql equals createChannelClassifier in ClickHouse', () => {
  const rows = [];
  for (const rt of [null, 0, 1, 2, 3]) {
    for (const rn of [null, '', 'klaviyo', 'facebook', 'instagram', 'ran', 'shopmy', 'x-abandon-y', 'welcome', 'google']) {
      for (const med of [null, '', 'email', 'flow', 'sms', 'paid', 'paid_social', 'affiliate', 'cpc', 'text', 'browse_abandonment', 'x']) {
        for (const src of [null, '', 'facebook', 'ig', 'ranx', 'shopmy', 'abandoned', 'welcome_1', 'x']) {
          for (const camp of [null, '', 'c']) rows.push({ rt, rn, med, src, camp });
        }
      }
    }
  }
  const columns = {
    referer_type: 'ifNull(rt, 0)',
    referer_name: "ifNull(rn, '')",
    utm_medium: "ifNull(med, '')",
    utm_campaign: "ifNull(camp, '')",
    source_or_referrer: "ifNull(src, '')",
  };
  const fields = (row) => ({ referer_type: row.rt, referer_name: row.rn, utm_medium: row.med, utm_campaign: row.camp, source_or_referrer: row.src });

  it(`agrees on all ${rows.length} combinations for both tables, nulls included`, () => {
    const out = runLocal('rt Nullable(UInt8), rn Nullable(String), med Nullable(String), src Nullable(String), camp Nullable(String)', rows,
      `SELECT ${channelSql(VISIT_CHANNEL, columns)} AS v, ${channelSql(LINK_CHANNEL, columns)} AS l FROM {table}`);
    expect(out.map((row) => `${row.v}|${row.l}`)).toEqual(rows.map((row) => `${visit(fields(row))}|${link(fields(row))}`));
  });
});
