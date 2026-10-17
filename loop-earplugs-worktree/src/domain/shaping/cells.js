import { addDays } from './dates.js';
import { periodOf, previousStart } from './period.js';
import { keyValue } from './sources.js';

/**
 * The cells of a shaped dataset and the steps that turn the query's rows
 * and the sources' rows into its output rows. A cell is one period, one
 * (segment, value) pair, and one value per `by` key, with its measures.
 *
 * Every session and source measure adds across disjoint cells: a session
 * has one value of each attribute in a period, and a source row has one
 * value of each key. So mapping keys through a lookup, folding ranks into
 * (other), and rolling days all sum, and every derived ratio is computed
 * after the sums. A source measure is known only on segment = all, because
 * a source cannot split by a segmentation of sessions; elsewhere it is null.
 *
 * @typedef {{period: string, segment: string, value: string, keys: Array<string | number>, m: Record<string, number | null>}} Cell
 * @typedef {{key: string, column: string, table: ReadonlyMap<string, Record<string, string>>, fallback: string}} Lookup
 */

export const OTHER = '(other)';

const identity = (cell) => JSON.stringify([cell.period, cell.segment, cell.value, ...cell.keys]);
const seriesOf = (cell) => JSON.stringify([cell.segment, cell.value, ...cell.keys]);
const keysOf = (cell) => JSON.stringify(cell.keys);

/** null + null is null; otherwise a missing side counts as 0. */
function plus(a, b) {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

/**
 * Cells with the same identity summed into one.
 * @param {Cell[]} cells
 * @param {string[]} additive
 * @returns {Cell[]}
 */
export function aggregate(cells, additive) {
  const out = new Map();
  for (const cell of cells) {
    const id = identity(cell);
    const prior = out.get(id);
    if (!prior) {
      out.set(id, { ...cell, keys: [...cell.keys], m: { ...cell.m } });
      continue;
    }
    for (const name of additive) prior.m[name] = plus(prior.m[name], cell.m[name]);
  }
  return [...out.values()];
}

/** The value of a lookup attribute for a key attribute's value. */
export function lookupValue(lookup, value) {
  return lookup.table.get(String(value))?.[lookup.column] ?? lookup.fallback;
}

/**
 * The query's rows as cells keyed by `by`. The query groups by the
 * attributes it computes (`queryKeys`, aliased a_<id>); a lookup key takes
 * its value from the attribute it is looked up by. Number attributes come
 * back as numbers, whatever the JSON quoting of 64-bit integers.
 * @param {object[]} rows
 * @param {{by: string[], queryKeys: string[], types: ReadonlyMap<string, 'string' | 'number'>, lookups: ReadonlyMap<string, Lookup>, sessionMeasures: string[]}} spec
 * @returns {Cell[]}
 */
export function queryCells(rows, { by, queryKeys, types, lookups, sessionMeasures }) {
  return rows.map((row) => {
    const attrs = {};
    for (const id of queryKeys) {
      const raw = row[`a_${id}`];
      attrs[id] = types.get(id) === 'number' ? Number(raw ?? 0) : String(raw ?? '');
    }
    return {
      period: String(row.week_start),
      segment: String(row.segment),
      value: String(row.segment_value),
      keys: by.map((id) => (lookups.has(id) ? lookupValue(lookups.get(id), attrs[lookups.get(id).key]) : attrs[id])),
      m: Object.fromEntries(sessionMeasures.map((name) => [name, Number(row[name] ?? 0)])),
    };
  });
}

/**
 * One fact source's rows as segment = all cells keyed by `by`, and the
 * totals of its measures over the output periods. Each row's keys are
 * mapped onto attribute values first; the filter reads those values, and a
 * lookup key reads the attribute it is looked up by. Rows outside the
 * query window are left out.
 * @param {object} spec
 * @param {import('./sources.js').SourceKind} spec.kind
 * @param {Array<Record<string, string | number>>} spec.rows typed rows
 * @param {string[]} spec.measures the source's measure names the request reads
 * @param {string[]} spec.by
 * @param {ReadonlyMap<string, Lookup>} spec.lookups
 * @param {((values: Record<string, unknown>) => boolean) | null} spec.filter
 * @param {import('./period.js').PeriodSpec} spec.period
 * @param {{start: string, end: string}} spec.window
 * @param {{start: string, end: string}} spec.queryWindow
 * @param {ReadonlySet<string>} spec.outputPeriods
 * @returns {{cells: Cell[], totals: Record<string, number>}}
 */
export function sourceCells({ kind, rows, measures, by, lookups, filter, period, window, queryWindow, outputPeriods }) {
  const cells = [];
  const totals = Object.fromEntries(measures.map((name) => [`${kind.id}.${name}`, 0]));
  for (const row of rows) {
    if (row.date < queryWindow.start || row.date > queryWindow.end) continue;
    const values = Object.fromEntries(kind.keys.map((mapping) => [mapping.attribute, keyValue(mapping, row[mapping.column])]));
    if (filter && !filter(values)) continue;
    const at = periodOf(String(row.date), period, window);
    const m = Object.fromEntries(measures.map((name) => [`${kind.id}.${name}`, Number(row[name])]));
    if (outputPeriods.has(at)) for (const [name, value] of Object.entries(m)) totals[name] += value;
    cells.push({
      period: at,
      segment: 'all',
      value: 'all',
      keys: by.map((id) => (lookups.has(id) ? lookupValue(lookups.get(id), values[lookups.get(id).key]) : values[id])),
      m,
    });
  }
  return { cells: aggregate(cells, Object.keys(totals)), totals };
}

/**
 * The session cells and the source cells in one set. A source measure is
 * 0 on an all cell no source row reached and null off segment = all. A
 * source cell with no session cell, spend on a campaign nobody arrived
 * from, becomes an all cell with zero sessions.
 * @param {Cell[]} sessionCells
 * @param {Cell[]} sourceCellList
 * @param {{sessionMeasures: string[], sourceMeasures: string[]}} names
 */
export function mergeSources(sessionCells, sourceCellList, { sessionMeasures, sourceMeasures }) {
  const out = new Map();
  for (const cell of sessionCells) {
    const m = { ...cell.m };
    for (const name of sourceMeasures) m[name] = cell.segment === 'all' ? 0 : null;
    out.set(identity(cell), { ...cell, m });
  }
  for (const cell of sourceCellList) {
    const id = identity(cell);
    let target = out.get(id);
    if (!target) {
      target = { ...cell, keys: [...cell.keys], m: Object.fromEntries([...sessionMeasures.map((name) => [name, 0]), ...sourceMeasures.map((name) => [name, 0])]) };
      out.set(id, target);
    }
    for (const [name, value] of Object.entries(cell.m)) target.m[name] = (target.m[name] ?? 0) + value;
  }
  return [...out.values()];
}

/** A derived measure's value from additive values, or null when it cannot divide. */
export function ratioOf(measure, m) {
  const [num, den] = measure.ratio;
  if (m[num] == null || m[den] == null || m[den] === 0) return null;
  return (m[num] / m[den]) * (measure.scale ?? 1);
}

/**
 * Keeps the top `limit` key combinations by the rank measure, summed over
 * the output periods on segment = all, and folds the rest into (other)
 * unless `other` is false, in which case they are dropped. Ties go to the
 * key that sorts first.
 * @param {Cell[]} cells
 * @param {{rank: {by: string, order: 'desc' | 'asc', limit: number, other: boolean}, measure: import('./measures.js').Measure, additive: string[], outputPeriods: ReadonlySet<string>}} spec
 * @returns {{cells: Cell[], order: string[], folded: number}}
 */
export function rankKeys(cells, { rank, measure, additive, outputPeriods }) {
  const totals = new Map();
  for (const cell of cells) {
    if (cell.segment !== 'all' || !outputPeriods.has(cell.period)) continue;
    const key = keysOf(cell);
    const sum = totals.get(key) ?? {};
    for (const name of additive) sum[name] = plus(sum[name], cell.m[name]);
    totals.set(key, sum);
  }
  const score = (sum) => (measure.kind === 'derived' ? ratioOf(measure, sum) : sum[measure.id] ?? null);
  const ranked = [...totals].map(([key, sum]) => ({ key, score: score(sum) })).sort((a, b) => {
    if (a.score === null && b.score === null) return a.key.localeCompare(b.key);
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    if (a.score !== b.score) return rank.order === 'desc' ? b.score - a.score : a.score - b.score;
    return a.key.localeCompare(b.key);
  });
  const kept = new Set(ranked.slice(0, rank.limit).map((entry) => entry.key));
  const folded = ranked.length - kept.size;
  if (folded === 0) return { cells, order: ranked.map((entry) => entry.key), folded };
  if (!rank.other) return { cells: cells.filter((cell) => kept.has(keysOf(cell))), order: [...kept], folded };
  const width = cells[0]?.keys.length ?? 0;
  const otherKey = JSON.stringify(Array(width).fill(OTHER));
  const moved = cells.map((cell) => (kept.has(keysOf(cell)) ? cell : { ...cell, keys: Array(width).fill(OTHER) }));
  return { cells: aggregate(moved, additive), order: [...kept, otherKey], folded };
}

/**
 * Each output day's trailing `days`-day sums, per series. A series is
 * dense over the output days once it has any cell, so a chart reads every
 * day; a day with nothing in its trailing span reads 0.
 * @param {Cell[]} cells day cells over the query window
 * @param {{days: number, outputDays: string[], sessionMeasures: string[], sourceMeasures: string[]}} spec
 * @returns {Cell[]}
 */
export function rollingCells(cells, { days, outputDays, sessionMeasures, sourceMeasures }) {
  const bySeries = new Map();
  for (const cell of cells) {
    const series = seriesOf(cell);
    if (!bySeries.has(series)) bySeries.set(series, { head: cell, days: new Map() });
    bySeries.get(series).days.set(cell.period, cell);
  }
  const out = [];
  for (const { head, days: byDay } of bySeries.values()) {
    for (const day of outputDays) {
      const m = Object.fromEntries([
        ...sessionMeasures.map((name) => [name, 0]),
        ...sourceMeasures.map((name) => [name, head.segment === 'all' ? 0 : null]),
      ]);
      for (let back = 0; back < days; back += 1) {
        const cell = byDay.get(addDays(day, -back));
        if (!cell) continue;
        for (const name of [...sessionMeasures, ...sourceMeasures]) m[name] = plus(m[name], cell.m[name]);
      }
      out.push({ period: day, segment: head.segment, value: head.value, keys: [...head.keys], m });
    }
  }
  return out;
}

/** Every derived measure computed on every cell, in place. */
export function deriveAll(cells, derived) {
  for (const cell of cells) for (const measure of derived) cell.m[measure.id] = ratioOf(measure, cell.m);
  return cells;
}

/**
 * Each measure beside its value in the series' previous period, and the
 * relative change. A series with no cell in the previous period read 0 of
 * an additive measure there and has no derived value. A change from 0 or
 * from null is null.
 * @param {Cell[]} cells derived, over the query window
 * @param {{names: string[], derived: ReadonlySet<string>, sourceMeasures: ReadonlySet<string>, period: import('./period.js').PeriodSpec, window: {start: string, end: string}}} spec
 */
export function compareCells(cells, { names, derived, sourceMeasures, period, window }) {
  const byId = new Map(cells.map((cell) => [identity(cell), cell]));
  for (const cell of cells) {
    const prior = byId.get(identity({ ...cell, period: previousStart(period, window, cell.period) }));
    for (const name of names) {
      const absent = derived.has(name) || (sourceMeasures.has(name) && cell.segment !== 'all') ? null : 0;
      const before = prior ? prior.m[name] ?? null : absent;
      const now = cell.m[name] ?? null;
      cell.m[`${name}_previous`] = before;
      cell.m[`${name}_change`] = before == null || now == null || before === 0 ? null : (now - before) / before;
    }
  }
  return cells;
}

/**
 * The partition check: in every period and key combination, the values of
 * each segmentation hold exactly the sessions and orders of segment = all,
 * and only its declared values appear.
 * @param {Cell[]} cells
 * @param {ReadonlyArray<{id: string, values: readonly string[]}>} segmentations
 * @returns {string[]} problems, at most ten
 */
export function partitionProblems(cells, segmentations) {
  const problems = [];
  const groups = new Map();
  for (const cell of cells) {
    const key = JSON.stringify([cell.period, ...cell.keys]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cell);
  }
  for (const [key, group] of groups) {
    const all = group.find((cell) => cell.segment === 'all');
    for (const seg of segmentations) {
      const parts = group.filter((cell) => cell.segment === seg.id);
      for (const part of parts) if (!seg.values.includes(part.value)) problems.push(`${seg.id} returned ${part.value}, which is not one of its values`);
      for (const name of ['sessions', 'orders', 'revenue']) {
        const sum = parts.reduce((acc, part) => acc + (part.m[name] ?? 0), 0);
        const whole = all?.m[name] ?? 0;
        const off = name === 'revenue' ? Math.abs(sum - whole) > 0.01 : sum !== whole;
        if (off) problems.push(`${key}: ${seg.id} values hold ${name} ${sum}, segment all holds ${whole}`);
      }
    }
    if (problems.length >= 10) break;
  }
  return problems.slice(0, 10);
}

/**
 * The conservation check: each source measure summed over the all cells of
 * the output periods equals the source's own total over the rows those
 * periods hold, so no row was lost or doubled by a key mapping or a lookup.
 * @param {Cell[]} cells
 * @param {Record<string, number>} totals
 * @param {ReadonlySet<string>} outputPeriods
 */
export function conservationProblems(cells, totals, outputPeriods) {
  const problems = [];
  for (const [name, expected] of Object.entries(totals)) {
    const actual = cells.filter((cell) => cell.segment === 'all' && outputPeriods.has(cell.period)).reduce((acc, cell) => acc + (cell.m[name] ?? 0), 0);
    if (Math.abs(actual - expected) > 1e-6 * Math.max(1, Math.abs(expected))) problems.push(`${name}: the rows hold ${actual}, the source holds ${expected}`);
  }
  return problems;
}
