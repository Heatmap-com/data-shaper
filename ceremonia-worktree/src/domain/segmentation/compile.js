import { canonical } from '../canonical.js';
import { sqlString } from '../sql-literal.js';
import { foldCondition, predicateVisitor, sqlVisitor } from './conditions.js';
import { FIELDS } from './fields.js';

/**
 * The value expression of a declared segmentation in one query: a multiIf
 * over the query's columns, first rule first, the fallback last. Literals
 * come from the declaration and are quoted; column expressions come only
 * from the caller's map, never from the declaration.
 *
 * @param {import('./declaration.js').ResolvedSegmentation} seg
 * @param {Readonly<Record<string, string>>} columns field name → the query's non-null column expression
 * @returns {string}
 */
export function segmentationSql(seg, columns) {
  const visit = sqlVisitor(columns, `segmentation ${seg.id}`);
  const branches = seg.rules.map((rule) => `  ${foldCondition(rule.when, visit)}, ${sqlString(rule.value)}`);
  return `multiIf(\n${[...branches, `  ${sqlString(seg.fallback)}`].join(',\n')})`;
}

/**
 * The JavaScript twin of segmentationSql, over rows keyed by field name. A
 * missing or null field reads as its type default, as the SQL columns do.
 *
 * @param {import('./declaration.js').ResolvedSegmentation} seg
 * @returns {(row: Record<string, unknown>) => string}
 */
export function segmentationClassifier(seg) {
  const visit = predicateVisitor(FIELDS);
  const compiled = seg.rules.map((rule) => ({ value: rule.value, test: foldCondition(rule.when, visit) }));
  return (row) => compiled.find((rule) => rule.test(row))?.value ?? seg.fallback;
}

/**
 * What the segmentation means, as text: its rules with lists resolved and
 * its fallback. Two definitions with one stamp put every visit in the same
 * value, so the stamp is the version input.
 *
 * @param {import('./declaration.js').ResolvedSegmentation} seg
 */
export function segmentationStamp(seg) {
  return canonical({ rules: seg.rules, fallback: seg.fallback });
}
