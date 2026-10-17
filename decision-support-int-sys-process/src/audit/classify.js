import { LABELS, createPageClassifier, pathOf } from '../domain/page-class/index.js';

const shopifyTemplate = createPageClassifier({ labels: LABELS.template });

/**
 * Brand rules win, then the Shopify preset with the template labels.
 * Search stays its own template. Content, account, and other are unclassified.
 * Patterns compile once, so build one classifier per rule list.
 *
 * @param {Array<{pattern: string, template: string}>} [rules]
 * @returns {(url: string) => string}
 */
export function createTemplateClassifier(rules = []) {
  const brand = rules.map((rule) => ({ regex: new RegExp(rule.pattern, 'i'), template: rule.template }));
  return (url) => {
    const path = pathOf(url);
    return brand.find((rule) => rule.regex.test(path))?.template ?? shopifyTemplate(url);
  };
}

/**
 * One-off form of createTemplateClassifier.
 *
 * @param {string} url
 * @param {Array<{pattern: string, template: string}>} [rules]
 */
export function classifyTemplate(url, rules = []) {
  return createTemplateClassifier(rules)(url);
}
