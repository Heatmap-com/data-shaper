import { foldCondition, predicateVisitor, resolveLists } from '../segmentation/conditions.js';
import { FIELDS } from '../segmentation/fields.js';
import { LISTS } from '../segmentation/lists.js';
import { checkChannelTable } from './rules.js';

/**
 * @param {import('./rules.js').ChannelTable} table
 * @returns {(row: Record<string, unknown>) => string} over rows keyed by field name
 */
export function createChannelClassifier(table) {
  const { rules, fallback } = checkChannelTable(table);
  const visit = predicateVisitor(FIELDS);
  const compiled = rules.map((rule) => ({ channel: rule.channel, test: foldCondition(resolveLists(rule.when, LISTS), visit) }));
  return (row) => compiled.find((rule) => rule.test(row))?.channel ?? fallback;
}
