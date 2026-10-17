import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSegmentationRegistry, SHIPPED_DEFAULTS } from '../src/application/segmentation/registry.js';
import { loadSegmentationCatalog } from '../src/catalog/segmentations.js';
import { adaptersIn, discoverAdapterRoles } from '../src/discover.js';
import { BUNDLE_COLUMNS, bundleChannels } from '../py/bundle-export.mjs';

const roles = await discoverAdapterRoles(path.resolve('src/adapters'));
const adapters = adaptersIn(roles, 'segmentations');
const catalog = loadSegmentationCatalog();
const registry = (sites = []) => createSegmentationRegistry({ catalog, adapters, sites });
const GOOGLE_PAID = { value: 'google_paid', when: { all: [{ field: 'referer_type', in: [2, 6] }, { field: 'utm_medium', eq: 'cpc' }] } };
const DVF = {
  slug: 'dvf',
  idsite: 5795,
  defaults: { trend: ['traffic_source', 'channel'] },
  overrides: { channel: { prepend: [GOOGLE_PAID], remove: ['affiliate'] } },
  declarations: [{
    id: 'paid_social', label: 'Paid social', purpose: 'P', data: 'D',
    rules: [{ value: 'paid', when: { field: 'utm_medium', in: '@paid_mediums' } }], fallback: 'unpaid',
  }],
};

describe('the segmentation registry', () => {
  it('mounts return_intent from the adapters role with its descriptor', () => {
    expect(adapters.map((adapter) => adapter.id)).toEqual(['return_intent']);
    const intent = registry().forSite(1).get('return_intent');
    expect(intent.kind).toBe('computed');
    expect(intent.classify).toBeNull();
    expect(intent.descriptor.purpose).toMatch(/earlier visits/);
    expect(intent.stamp({ lookbackDays: 30, interest: { min_pages: 3, min_clicks: 2, min_scroll_pct: 50, min_duration_sec: 30 } }))
      .toBe('{"codeVersion":1,"lookbackDays":30,"minClicks":2,"minDurationMs":30000,"minPages":3,"minScroll":500}');
  });

  it('reads the shipped defaults for a site without a file', () => {
    const reg = registry();
    expect(reg.defaults(1, 'trend')).toEqual(SHIPPED_DEFAULTS.trend);
    expect(reg.select(1, 'tagTrend').map((seg) => seg.id)).toEqual(['traffic_source', 'returning', 'buyer', 'rager', 'return_intent']);
    expect(reg.select(1, 'experiments').map((seg) => seg.id)).toEqual(['traffic_source', 'returning']);
    expect(reg.sourceOf(1, 'trend')).toBe('shipped');
  });

  it('applies a site override and adds its declarations, for that site only', () => {
    const reg = registry([DVF]);
    expect(reg.forSite(5795).get('channel').values).toEqual(['google_paid', 'direct', 'search', 'email_sms', 'meta_paid', 'meta_untagged', 'other']);
    expect(reg.forSite(5795).get('channel').classify({ referer_type: 2, utm_medium: 'cpc' })).toBe('google_paid');
    expect(reg.forSite(4879).get('channel').values).toContain('affiliate');
    expect(reg.forSite(4879).has('paid_social')).toBe(false);
    expect(reg.select(5795, 'trend').map((seg) => seg.id)).toEqual(['traffic_source', 'channel']);
    expect(reg.sourceOf(5795, 'trend')).toBe('site');
    expect(reg.select(5795, 'trend', ['paid_social']).map((seg) => seg.id)).toEqual(['paid_social']);
    expect(reg.sourceOf(5795, 'trend', ['paid_social'])).toBe('run');
    expect(reg.defaults(5795, 'tagTrend')).toEqual(SHIPPED_DEFAULTS.tagTrend);
  });

  it('refuses a duplicate id across the catalog and the adapters, naming both', () => {
    const clash = { ...adapters[0], id: 'buyer' };
    expect(() => createSegmentationRegistry({ catalog, adapters: [clash] }))
      .toThrow(/segmentation buyer is defined twice: catalog segmentations\/buyer.json and adapter segmentations\/buyer/);
    const declaration = { ...DVF.declarations[0], id: 'channel' };
    expect(() => registry([{ ...DVF, overrides: {}, declarations: [declaration] }]))
      .toThrow(/sites\/dvf\/segmentations.json: segmentation channel is already defined by catalog segmentations\/channel.json/);
  });

  it('refuses an override of a computed segmentation, or of an unknown one', () => {
    expect(() => registry([{ ...DVF, overrides: { return_intent: { fallback: 'x' } } }])).toThrow(/cannot override return_intent: it is computed/);
    expect(() => registry([{ ...DVF, overrides: { tiktok: { fallback: 'x' } } }])).toThrow(/cannot override tiktok: it is not a shipped declared/);
  });

  it('refuses an unknown id, a repeat, a computed one outside its grains, and two files for one site', () => {
    const reg = registry([DVF]);
    expect(() => reg.select(5795, 'trend', ['tiktok'])).toThrow(/idsite 5795: unknown segmentation "tiktok" \(buyer, channel.*return_intent, paid_social\)/);
    expect(() => reg.select(1, 'trend', ['buyer', 'buyer'])).toThrow(/buyer is selected twice/);
    expect(() => reg.select(1, 'experiments', ['return_intent'])).toThrow(/return_intent cannot be read in experiments \(trend, tagTrend\)/);
    expect(() => reg.select(1, 'bundle')).toThrow(/unknown segmentation grain "bundle"/);
    expect(() => registry([DVF, { ...DVF, slug: 'dvf-copy' }])).toThrow(/idsite 5795 has two segmentation files: sites\/dvf and sites\/dvf-copy/);
    expect(() => registry([{ ...DVF, defaults: { experiments: ['return_intent'] } }])).toThrow(/sites\/dvf\/segmentations.json: segmentation return_intent cannot be read in experiments/);
  });
});

describe('the bundle channels', () => {
  it('read the site override, and the shipped declaration elsewhere', () => {
    const reg = registry([DVF]);
    expect(bundleChannels(reg, 5795).visit.sql(BUNDLE_COLUMNS)).toMatch(/^multiIf\(\n  \(rt IN \(2, 6\) AND med = 'cpc'\), 'google_paid',/);
    expect(bundleChannels(reg, 5795).visit.sql(BUNDLE_COLUMNS)).not.toContain("'affiliate'");
    expect(bundleChannels(reg, 4879).visit.sql(BUNDLE_COLUMNS)).toBe(bundleChannels().visit.sql(BUNDLE_COLUMNS));
    expect(bundleChannels(reg, 5795).link.sql(BUNDLE_COLUMNS)).toBe(bundleChannels().link.sql(BUNDLE_COLUMNS));
  });
});
