import { PATH_CONDITIONS, conditionEntry } from './conditions.js';
import { normalizeUrl, pathOf } from './normalize.js';
import { SHOPIFY, checkPageRules } from './rules.js';

/**
 * @param {{rules?: readonly import('./rules.js').PageRule[], labels?: Record<string, string>, fallback?: string}} [options]
 * @returns {(url: unknown) => string}
 */
export function createPageClassifier({ rules = SHOPIFY, labels = {}, fallback = 'other' } = {}) {
  const label = (name) => labels[name] ?? name;
  const compiled = checkPageRules(rules).map((rule) => ({
    name: label(rule.class),
    tests: rule.when.map((condition) => {
      const [kind, value] = conditionEntry(condition);
      return PATH_CONDITIONS[kind].js(value);
    }),
  }));
  return (url) => {
    const text = normalizeUrl(url);
    if (text === '') return label('unknown');
    const path = pathOf(text, { normalize: false });
    for (const rule of compiled) if (rule.tests.some((test) => test(path))) return rule.name;
    return label(fallback);
  };
}
