import { deepFreeze } from '../freeze.js';
import { PATH_CONDITIONS } from './conditions.js';

/**
 * Page-class rules are data. A rule names a class and a list of conditions on
 * the page path (see pathOf); any one condition matching is enough. The first
 * rule that matches wins, so order is part of the table.
 *
 * Conditions are the kinds in PATH_CONDITIONS: { root: true } the path is '' or
 * '/'; { startsWith }; { contains }; { equals } compared with trailing slashes
 * trimmed; { match } a case-insensitive regular expression that both
 * JavaScript and RE2 accept.
 *
 * @typedef {{root?: true, startsWith?: string, contains?: string, equals?: string, match?: string}} PathCondition
 * @typedef {{class: string, when: PathCondition[]}} PageRule
 * @typedef {{preset?: string, prepend?: PageRule[], append?: PageRule[], remove?: string[]}} PageClassSpec
 */

/** @type {readonly PageRule[]} */
export const SHOPIFY = deepFreeze([
  { class: 'home', when: [{ root: true }] },
  { class: 'product', when: [{ contains: '/products/' }, { startsWith: '/products' }] },
  { class: 'collection', when: [{ contains: '/collections/' }, { startsWith: '/collections' }] },
  { class: 'cart', when: [{ equals: '/cart' }] },
  { class: 'search', when: [{ startsWith: '/search' }] },
  { class: 'content', when: [{ startsWith: '/blogs' }, { startsWith: '/pages' }, { contains: '/blogs/' }, { contains: '/pages/' }] },
  { class: 'checkout', when: [{ contains: '/checkout' }] },
  { class: 'account', when: [{ startsWith: '/account' }] },
]);

export const PRESETS = deepFreeze({ shopify: SHOPIFY });

/**
 * Consumers keep their own names for the same classes. `unknown` is an empty
 * URL; `other` is the fallback when no rule matches.
 */
export const LABELS = deepFreeze({
  page: {},
  template: { product: 'pdp', collection: 'plp', cart: 'cart_page', content: 'unclassified', account: 'unclassified', other: 'unclassified', unknown: 'unclassified' },
  trend: { product: 'pdp', collection: 'plp', unknown: 'other' },
  bundle: { checkout: 'cart', unknown: 'other' },
});

/**
 * A preset with a site's changes: `prepend` rules run first, `remove` drops
 * classes from the preset, and `append` rules run last.
 *
 * @param {PageClassSpec} [spec]
 * @returns {PageRule[]}
 */
export function resolvePageRules(spec = {}) {
  const preset = PRESETS[spec.preset ?? 'shopify'];
  if (!preset) throw new Error(`unknown page-class preset "${spec.preset}" (${Object.keys(PRESETS).join(', ')})`);
  const removed = new Set(spec.remove ?? []);
  return checkPageRules([...(spec.prepend ?? []), ...preset.filter((rule) => !removed.has(rule.class)), ...(spec.append ?? [])]);
}

/**
 * Checks every rule and returns them in stored form (plain values lower-cased,
 * patterns compiled once to prove they parse). Throws on the first bad rule.
 *
 * @param {readonly PageRule[]} rules
 * @returns {PageRule[]}
 */
export function checkPageRules(rules) {
  if (!Array.isArray(rules)) throw new Error('page rules must be a list');
  return rules.map(checkRule);
}

/** @param {PageRule} rule */
function checkRule(rule) {
  if (!rule || typeof rule.class !== 'string' || !rule.class) throw new Error(`page rule needs a class: ${JSON.stringify(rule)}`);
  if (!Array.isArray(rule.when) || rule.when.length === 0) throw new Error(`page rule "${rule.class}" needs at least one condition`);
  const when = rule.when.map((condition) => {
    const keys = Object.keys(condition ?? {});
    if (keys.length !== 1 || !Object.hasOwn(PATH_CONDITIONS, keys[0])) {
      throw new Error(`page rule "${rule.class}": a condition is one of ${Object.keys(PATH_CONDITIONS).join(', ')}, got ${JSON.stringify(condition)}`);
    }
    const [kind] = keys;
    try {
      return { [kind]: PATH_CONDITIONS[kind].value(condition[kind]) };
    } catch (err) {
      throw new Error(`page rule "${rule.class}": ${kind} ${JSON.stringify(condition[kind])} is not valid: ${err.message}`, { cause: err });
    }
  });
  return { class: rule.class, when };
}
