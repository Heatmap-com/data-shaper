/**
 * The segmentation fan-out every segmented aggregate shares. Each inner row
 * is one visit under one (segment, value) pair, so one GROUP BY gives every
 * segmentation's cells without crossing them.
 */

/** @typedef {import('../ports/segmentation.js').Segmentation} Segmentation */
/** @typedef {{segmentations: Segmentation[], withAll: boolean}} QueryGroup */

export const DEFAULT_SEGMENTATION_BUDGET = 48;

/**
 * The array of (segment, value) tuples; `withAll` adds ('all', 'all').
 * @param {ReadonlyArray<Segmentation>} segmentations
 * @param {Readonly<Record<string, string>>} columns the grain's column map
 * @param {{withAll: boolean}} options
 */
export function segmentTuplesSql(segmentations, columns, { withAll }) {
  const tuples = [
    ...(withAll ? ["tuple('all', 'all')"] : []),
    ...segmentations.map((seg) => `tuple('${seg.id}', ${seg.sql(columns)})`),
  ];
  if (tuples.length === 0) throw new Error('a segmentation fan-out needs at least one tuple');
  return `[\n             ${tuples.join(',\n             ')}]`;
}

/**
 * `arrayJoin` of (segment, value) tuples; `withAll` adds ('all', 'all').
 * @param {ReadonlyArray<Segmentation>} segmentations
 * @param {Readonly<Record<string, string>>} columns the grain's column map
 * @param {{withAll: boolean}} options
 */
export function fanoutSql(segmentations, columns, options) {
  return `arrayJoin(${segmentTuplesSql(segmentations, columns, options)})`;
}

/**
 * Packs segmentations into query groups whose value counts sum to at most
 * `budget`, in selection order. The first group carries the `all` tuple.
 * @param {Segmentation[]} segmentations
 * @param {number} [budget]
 * @returns {QueryGroup[]}
 */
export function planGroups(segmentations, budget = DEFAULT_SEGMENTATION_BUDGET) {
  /** @type {QueryGroup[]} */
  const groups = [];
  let current = [];
  let size = 0;
  for (const seg of segmentations) {
    if (seg.values.length > budget) {
      throw new Error(`segmentation ${seg.id} has ${seg.values.length} values, over the query budget of ${budget}`);
    }
    if (size + seg.values.length > budget) {
      groups.push({ segmentations: current, withAll: groups.length === 0 });
      current = [];
      size = 0;
    }
    current.push(seg);
    size += seg.values.length;
  }
  groups.push({ segmentations: current, withAll: groups.length === 0 });
  return groups;
}

/**
 * The extra CTEs a group needs (each preceded by a comma), the joins its
 * computed segmentations add, and whether it reads the rage-click CTE.
 * @param {QueryGroup} group
 * @param {object} inputs the run inputs
 */
export function groupParts(group, inputs) {
  const computed = group.segmentations.filter((seg) => seg.kind === 'computed');
  const ctes = [...new Set(computed.map((seg) => seg.ctes(inputs)).filter(Boolean))];
  const joins = [...new Set(computed.map((seg) => seg.joins(inputs)).filter(Boolean))];
  return {
    ragers: group.segmentations.some((seg) => seg.needs.includes('ragers')),
    ctes: ctes.map((cte) => `,\n${cte}`).join(''),
    joins: joins.join('\n    '),
  };
}

/**
 * The parameters a group's computed segmentations bind.
 * @param {QueryGroup} group
 * @param {object} inputs the run inputs, with `start`, the query's first day
 */
export function groupParams(group, inputs) {
  return Object.assign({}, ...group.segmentations.filter((seg) => seg.kind === 'computed').map((seg) => seg.params(inputs)));
}

/**
 * The inner SELECT and outer GROUP BY of one segmented aggregate. The
 * measures are the same functions on the same per-visit values as the
 * crossed cells had, so each (segment, value) cell is the sum of the
 * crossed cells for that value.
 * @param {object} spec
 * @param {QueryGroup} spec.group
 * @param {Readonly<Record<string, string>>} spec.columns
 * @param {string} spec.viewport the viewport expression
 * @param {Array<[string, string]>} spec.keys [expression, name] pairs the cells are keyed by
 * @param {string} spec.from the FROM and its inner joins, binding `k`
 * @param {string} spec.joins the trailing LEFT JOINs (orders, checkout, ragers, computed)
 * @param {string} [spec.where]
 * @param {Array<[string, string, string]>} [spec.extra] [inner expression, inner name, outer aggregate AS name]
 */
export function segmentedSelect(spec) {
  const grouped = ['week_start', 'viewport_value', 'segment', 'segment_value', ...spec.keys.map(([, name]) => name)].join(', ');
  const extra = spec.extra ?? [];
  return `SELECT ${grouped},${extra.map(([, , outer]) => `\n       ${outer},`).join('')}
       uniqExact(idvisit) AS sessions,
       uniqExactIf(idvisit, v_orders > 0) AS buyers,
       sum(v_orders) AS orders,
       sum(v_revenue) AS revenue,
       uniqExactIf(idvisit, v_progressed) AS progressed
FROM (
    SELECT toString(k.week) AS week_start,
           ${spec.viewport} AS viewport_value,
           ${fanoutSql(spec.group.segmentations, spec.columns, spec.group)} AS seg,
           tupleElement(seg, 1) AS segment,
           tupleElement(seg, 2) AS segment_value,
${spec.keys.map(([expr, name]) => `           ${expr} AS ${name},\n`).join('')}${extra.map(([expr, name]) => `           ${expr} AS ${name},\n`).join('')}           k.idvisit AS idvisit,
           ifNull(o.orders, 0) AS v_orders,
           ifNull(o.revenue, 0) AS v_revenue,
           ck.idvisit = k.idvisit AS v_progressed
    FROM ${spec.from}
    ${spec.joins}${spec.where ? `\n    WHERE ${spec.where}` : ''}
)
GROUP BY ${grouped}
`;
}
