import { sqlString } from '../sql-literal.js';
import { foldCondition, resolveLists, sqlVisitor } from '../segmentation/conditions.js';
import { LISTS } from '../segmentation/lists.js';
import { checkChannelTable } from './rules.js';

/**
 * SQL twin of createChannelClassifier, over the target query's columns.
 *
 * @param {import('./rules.js').ChannelTable} table
 * @param {Readonly<Record<string, string>>} columns field name → the query's non-null column expression
 */
export function channelSql(table, columns) {
  const { rules, fallback } = checkChannelTable(table);
  const visit = sqlVisitor(columns, 'channel table');
  const branches = rules.map((rule) => `  ${foldCondition(resolveLists(rule.when, LISTS), visit)}, ${sqlString(rule.channel)}`);
  return `multiIf(\n${[...branches, `  ${sqlString(fallback)}`].join(',\n')})`;
}
