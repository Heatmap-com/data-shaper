import { deepFreeze } from '../freeze.js';
import { checkCondition } from '../segmentation/conditions.js';
import { FIELDS } from '../segmentation/fields.js';
import { LISTS } from '../segmentation/lists.js';

/**
 * Channel rules are data over the registered segmentation fields
 * (`src/domain/segmentation/fields.js`). The first rule that matches wins.
 *
 * Conditions are the segmentation condition language: { field, <operator> }
 * with one operator (eq, ne, in, like as case-sensitive SQL LIKE,
 * startsWith), or { any: [] } | { all: [] }. An `in` list may name a shared
 * list as "@name".
 *
 * @typedef {import('../segmentation/conditions.js').Condition} Condition
 * @typedef {{channel: string, when: Condition}} ChannelRule
 * @typedef {{rules: readonly ChannelRule[], fallback: string}} ChannelTable
 * @typedef {{prepend?: ChannelRule[], append?: ChannelRule[], remove?: string[], fallback?: string}} ChannelSpec
 */

export const VOCABULARY = deepFreeze({ fields: FIELDS, lists: LISTS });

/** Where the visit came from, by referer and medium. @type {ChannelTable} */
export const VISIT_CHANNEL = deepFreeze({
  rules: [
    { channel: 'direct', when: { field: 'referer_type', eq: 1 } },
    { channel: 'search', when: { field: 'referer_type', eq: 2 } },
    { channel: 'email_sms', when: { any: [{ field: 'referer_name', eq: 'klaviyo' }, { field: 'utm_medium', in: ['email', 'flow', 'sms'] }, { field: 'referer_name', like: '%abandon%' }, { field: 'referer_name', like: '%welcome%' }] } },
    { channel: 'meta_paid', when: { all: [{ field: 'referer_name', in: '@meta_referers' }, { field: 'utm_medium', in: '@paid_mediums' }] } },
    { channel: 'meta_untagged', when: { field: 'referer_name', in: '@meta_referers' } },
    { channel: 'affiliate', when: { any: [{ field: 'referer_name', in: ['ran', 'shopmy'] }, { field: 'utm_medium', eq: 'affiliate' }] } },
  ],
  fallback: 'other',
});

const META_TAGGED = { any: [{ field: 'source_or_referrer', in: '@meta_utm_sources' }, { field: 'utm_medium', in: '@paid_mediums' }] };

/** Which campaign link the visit carried, by UTM source, medium, and campaign. @type {ChannelTable} */
export const LINK_CHANNEL = deepFreeze({
  rules: [
    { channel: 'automated_email_flow', when: { any: [{ field: 'utm_medium', eq: 'flow' }, { field: 'source_or_referrer', like: '%abandon%' }, { field: 'source_or_referrer', like: '%welcome%' }, { field: 'utm_medium', eq: 'browse_abandonment' }] } },
    { channel: 'affiliate', when: { any: [{ field: 'utm_medium', eq: 'affiliate' }, { field: 'source_or_referrer', startsWith: 'ran' }, { field: 'source_or_referrer', eq: 'shopmy' }] } },
    { channel: 'google_ads', when: { field: 'utm_medium', eq: 'cpc' } },
    { channel: 'campaign_email_sms', when: { field: 'utm_medium', in: ['email', 'text', 'sms', 'newsletter'] } },
    { channel: 'meta', when: { all: [META_TAGGED, { any: [{ field: 'utm_medium', ne: '' }, { field: 'utm_campaign', ne: '' }] }] } },
    { channel: 'meta_no_link', when: META_TAGGED },
    { channel: 'no_campaign_link', when: { all: [{ field: 'utm_medium', eq: '' }, { field: 'utm_campaign', eq: '' }] } },
  ],
  fallback: 'other_tagged',
});

export const CHANNEL_TABLES = deepFreeze({ visit: VISIT_CHANNEL, link: LINK_CHANNEL });

/**
 * A table with a site's changes: `prepend` runs first, `remove` drops channels,
 * `append` runs before the fallback, and `fallback` renames it.
 *
 * @param {'visit'|'link'} kind
 * @param {ChannelSpec} [spec]
 * @returns {ChannelTable}
 */
export function resolveChannelRules(kind, spec = {}) {
  const table = CHANNEL_TABLES[kind];
  if (!table) throw new Error(`unknown channel table "${kind}" (${Object.keys(CHANNEL_TABLES).join(', ')})`);
  const removed = new Set(spec.remove ?? []);
  const rules = [...(spec.prepend ?? []), ...table.rules.filter((rule) => !removed.has(rule.channel)), ...(spec.append ?? [])];
  return checkChannelTable({ rules, fallback: spec.fallback ?? table.fallback });
}

/**
 * Checks a table's rules and fallback against the field and list registry
 * and returns it. Throws on the first bad rule, so a classifier or SQL
 * fragment is never built from one.
 *
 * @param {ChannelTable} table
 * @returns {ChannelTable}
 */
export function checkChannelTable(table) {
  if (!table || !Array.isArray(table.rules)) throw new Error('a channel table needs a rules list');
  if (typeof table.fallback !== 'string' || !table.fallback) throw new Error('a channel table needs a fallback channel');
  for (const rule of table.rules) {
    if (!rule?.channel) throw new Error(`channel rule needs a channel: ${JSON.stringify(rule)}`);
    checkCondition(rule.when, VOCABULARY, `channel "${rule.channel}"`);
  }
  return table;
}
