import { sqlString } from '../sql-literal.js';
import { PATH_CONDITIONS, conditionEntry } from './conditions.js';
import { normalizedUrlSql, pathSql } from './normalize.js';
import { SHOPIFY, checkPageRules } from './rules.js';

/**
 * The `[condition, label]` pairs of a ClickHouse multiIf, in rule order.
 * Callers that put their own branches first (bound parameters, for example)
 * use this with pathSql.
 *
 * @param {string} path a pathSql expression
 * @param {{rules?: readonly import('./rules.js').PageRule[], labels?: Record<string, string>}} [options]
 * @returns {string[]}
 */
export function pageClassBranches(path, { rules = SHOPIFY, labels = {} } = {}) {
  return checkPageRules(rules).flatMap((rule) => {
    const parts = rule.when.map((condition) => {
      const [kind, value] = conditionEntry(condition);
      return PATH_CONDITIONS[kind].sql(path, value);
    });
    return [parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`, sqlString(labels[rule.class] ?? rule.class)];
  });
}

/**
 * SQL twin of createPageClassifier: same rules, same labels, same answer.
 *
 * @param {string} urlExpr
 * @param {{rules?: readonly import('./rules.js').PageRule[], labels?: Record<string, string>, fallback?: string, normalize?: boolean, before?: string[]}} [options]
 *   `before` holds extra `[condition, label]` pairs that run ahead of the rules.
 */
export function pageClassSql(urlExpr, { rules = SHOPIFY, labels = {}, fallback = 'other', normalize = true, before = [] } = {}) {
  const url = normalize ? normalizedUrlSql(urlExpr) : `ifNull(${urlExpr}, '')`;
  const path = pathSql(urlExpr, { normalize });
  const label = (name) => sqlString(labels[name] ?? name);
  return `multiIf(${[`${url} = ''`, label('unknown'), ...before, ...pageClassBranches(path, { rules, labels }), label(fallback)].join(', ')})`;
}
