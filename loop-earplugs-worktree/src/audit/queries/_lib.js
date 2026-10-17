/**
 * Builders the audit acquisition queries share: the query spec, the date
 * and page range params, the ordered path expression, and the GROUP BY
 * tail of a click-class select list.
 */

import { chunkDaysFor } from '../bounds.js';
import { hsrParams } from '../sql.js';

/** @param {string} templateExpr */
export function pathExpr(templateExpr) {
  return `arrayStringConcat(arrayCompact(arrayMap(x -> x.2, arraySort(x -> x.1, groupArray(tuple(toUnixTimestamp(h.server_time), ${templateExpr}))))), ' > ')`;
}

const AGGREGATE_FN = /\b(countIf|uniqExactIf|uniqExact|sumIf|avgIf|minIf|maxIf|count|sum|avg|any|min|max|quantile)\s*\(/;

/**
 * GROUP BY the dimension aliases in a select list. Metric aggregates are skipped.
 * @param {string} selectList
 */
export function groupTail(selectList) {
  const dims = [];
  for (const part of splitSelect(selectList)) {
    const trimmed = part.trim();
    const alias = trimmed.match(/\bAS\s+([a-z_]+)\s*$/i);
    if (!alias) continue;
    const expr = trimmed.slice(0, alias.index);
    if (AGGREGATE_FN.test(expr)) continue;
    dims.push(alias[1]);
  }
  return dims.join(', ') || 'element_class';
}

/** Split a select list on commas that are not inside parentheses. */
function splitSelect(selectList) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selectList.length; i += 1) {
    const ch = selectList[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(selectList.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selectList.slice(start));
  return parts;
}

/** @param {string} id @param {string} sql @param {object} params */
export function spec(id, sql, params) {
  return { id, label: `audit:${id}`, sql, params, chunkDays: chunkDaysFor(sql, params) };
}

/** @param {number} idsite @param {string} start @param {string} end @param {number[]|null} [hsrIds] */
export function range(idsite, start, end, hsrIds = null) {
  return { idsite, start, end, ...hsrParams(hsrIds) };
}
