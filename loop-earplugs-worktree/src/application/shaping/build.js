import { foldCondition, predicateVisitor } from '../../domain/segmentation/conditions.js';
import {
  aggregate, compareCells, conservationProblems, deriveAll, mergeSources, partitionProblems, queryCells, rankKeys, rollingCells, sourceCells,
} from '../../domain/shaping/cells.js';
import { eachDay } from '../../domain/shaping/dates.js';
import { SESSION_MEASURES } from '../../domain/shaping/measures.js';
import { periodParams } from '../../domain/shaping/period.js';
import { lookupTable, typedRows } from '../../domain/shaping/sources.js';
import { MAX_CELLS, shapeSql } from '../../enrichment/shape-sql.js';

/**
 * What a build read from each source, for the dataset's dictionary.
 * @typedef {{id: string, role: 'facts' | 'lookup', rows: number, rejected: number, coverage: {start: string, end: string} | null, conflicts?: number, partial?: string[]}} SourceRead
 */

/**
 * Reads the sources a plan needs and checks them: every row typed, and a
 * facts source covering every day the query reads unless the request
 * allows a partial source. Missing days, bad rows, or a fetch that fails
 * block the request; they are not filled in.
 * @param {import('./plan.js').ShapePlan} plan
 * @param {ReturnType<typeof import('./registry.js').createShapingRegistry>} shaping
 * @returns {Promise<{reasons: string[], notes: string[], facts: Map<string, Array<Record<string, string | number>>>, lookups: Map<string, ReadonlyMap<string, Record<string, string>>>, read: SourceRead[]}>}
 */
export async function readSources(plan, shaping) {
  const reasons = [];
  const notes = [];
  const facts = new Map();
  const lookups = new Map();
  const read = [];
  for (const source of [...plan.sources, ...plan.lookupSources]) {
    const kind = shaping.kinds.get(source);
    let fetched;
    try {
      fetched = await shaping.fetch(plan.idsite, source, kind.role === 'facts' ? plan.queryWindow : null);
    } catch (err) {
      reasons.push(`${source}: the fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const typed = typedRows(kind, fetched.rows);
    if (typed.rejected > 0) reasons.push(`${source}: ${typed.rejected} rows are not ${kind.label} rows (${typed.examples.join('; ')})`);
    if (kind.role === 'lookup') {
      const { table, conflicts } = lookupTable(kind, typed.rows);
      if (conflicts > 0) notes.push(`${source} lists ${conflicts} keys twice with different values; the first row of each is used`);
      lookups.set(source, table);
      read.push({ id: source, role: 'lookup', rows: typed.rows.length, rejected: typed.rejected, coverage: null, conflicts });
      continue;
    }
    const missing = eachDay(plan.queryWindow.start, plan.queryWindow.end)
      .filter((day) => !fetched.coverage || day < fetched.coverage.start || day > fetched.coverage.end);
    const partial = spans(missing);
    if (missing.length > 0) {
      const text = `${source} covers ${fetched.coverage ? `${fetched.coverage.start} to ${fetched.coverage.end}` : 'no days'}; the query reads ${plan.queryWindow.start} to ${plan.queryWindow.end}, so ${missing.length} days are missing (${partial.join(', ')})`;
      if ((plan.request.sources[source]?.partial ?? 'refuse') === 'allow') notes.push(`${text}; the request allows it, and those days read 0`);
      else reasons.push(`${text}. Refresh the connection, or set sources.${source}.partial to allow`);
    }
    facts.set(source, typed.rows);
    read.push({ id: source, role: 'facts', rows: typed.rows.length, rejected: typed.rejected, coverage: fetched.coverage, partial });
  }
  return { reasons, notes, facts, lookups, read };
}

/** Consecutive days as "a to b" spans. */
function spans(days) {
  const out = [];
  let start = null;
  let prev = null;
  for (const day of days) {
    if (prev && Date.parse(`${day}T00:00:00Z`) - Date.parse(`${prev}T00:00:00Z`) === 86400000) {
      prev = day;
      continue;
    }
    if (start) out.push(start === prev ? start : `${start} to ${prev}`);
    start = day;
    prev = day;
  }
  if (start) out.push(start === prev ? start : `${start} to ${prev}`);
  return out;
}

/**
 * Builds a planned dataset: one query per segmentation group, then the
 * cells from the query and the sources, the checks, the rank, the rolling
 * sums, the ratios, and the comparison. A check that fails returns
 * `failed` with what it found, and nothing is written.
 * @param {import('./plan.js').ShapePlan} plan
 * @param {Awaited<ReturnType<typeof readSources>>} sources
 * @param {{gateway: import('../../ports/query-gateway.js').QueryGateway, kinds: ReadonlyMap<string, import('../../domain/shaping/sources.js').SourceKind>,
 *   quality?: {sql: import('../../enrichment/shape-sql.js').QualityExclusions, params: Record<string, unknown>}}} deps
 *   `quality` is what the data-quality dispositions drop (exclusionsForBuild); none when absent
 */
export async function buildShape(plan, sources, { gateway, kinds, quality }) {
  const sessionMeasures = Object.keys(SESSION_MEASURES);
  const sourceMeasures = plan.measures.filter((m) => m.kind === 'source').map((m) => m.id);
  const additive = [...sessionMeasures, ...sourceMeasures];
  const lookups = new Map(plan.byAttributes.filter((attr) => attr.kind === 'lookup').map((attr) => [attr.id, {
    key: attr.lookup.key, column: attr.lookup.column, fallback: attr.lookup.fallback, table: sources.lookups.get(attr.lookup.source) ?? new Map(),
  }]));
  const types = new Map(plan.attributes.map((attr) => [attr.id, attr.type]));
  const params = {
    idsite: plan.idsite,
    w0: plan.queryWindow.start,
    w1: plan.queryWindow.end,
    cellLimit: MAX_CELLS + 1,
    ...periodParams(plan.period, plan.window),
    ...(quality?.params ?? {}),
  };

  const rows = [];
  for (const group of plan.groups) {
    const sql = shapeSql({ attributes: plan.attributes, queryKeys: plan.queryKeys, filter: plan.filter, period: plan.period, ...(quality ? { exclusions: quality.sql } : {}) }, group);
    const got = await gateway.query(sql, params, `shape:${plan.id}`);
    if (got.length > MAX_CELLS) {
      return { status: 'blocked', reasons: [`one query returned more than ${MAX_CELLS} cells; add a rank, a coarser period, or fewer by keys`] };
    }
    rows.push(...got);
  }

  let cells = aggregate(queryCells(rows, { by: plan.by, queryKeys: plan.queryKeys, types, lookups, sessionMeasures }), sessionMeasures);
  const outputPeriods = new Set(plan.periods.map((p) => p.start));
  const filterTest = plan.filter ? foldCondition(plan.filter, predicateVisitor()) : null;
  const fromSources = [];
  const totals = {};
  for (const source of plan.sources) {
    const result = sourceCells({
      kind: kinds.get(source),
      rows: sources.facts.get(source) ?? [],
      measures: plan.measures.filter((m) => m.source === source).map((m) => m.measure),
      by: plan.by,
      lookups,
      filter: filterTest,
      period: plan.period,
      window: plan.window,
      queryWindow: plan.queryWindow,
      outputPeriods,
    });
    fromSources.push(...result.cells);
    Object.assign(totals, result.totals);
  }
  cells = mergeSources(cells, fromSources, { sessionMeasures, sourceMeasures });

  const partition = partitionProblems(cells, plan.segmentations);
  const conservation = conservationProblems(cells, totals, outputPeriods);
  if (partition.length > 0 || conservation.length > 0) return { status: 'failed', reasons: [...partition, ...conservation] };

  let order = null;
  let folded = 0;
  if (plan.request.rank) {
    const ranked = rankKeys(cells, { rank: plan.request.rank, measure: plan.measures.find((m) => m.id === plan.request.rank.by), additive, outputPeriods });
    ({ cells, order, folded } = ranked);
  }
  if (plan.period.rolling) cells = rollingCells(cells, { days: plan.period.rolling, outputDays: plan.periods.map((p) => p.start), sessionMeasures, sourceMeasures });
  const derived = plan.measures.filter((m) => m.kind === 'derived');
  deriveAll(cells, derived);
  if (plan.period.compare) {
    compareCells(cells, { names: plan.output, derived: new Set(derived.map((m) => m.id)), sourceMeasures: new Set(sourceMeasures), period: plan.period, window: plan.window });
  }
  cells = cells.filter((cell) => outputPeriods.has(cell.period));

  return {
    status: 'built',
    cells,
    order,
    folded,
    queries: plan.groups.length,
    queryRows: rows.length,
    checks: {
      partition: plan.segmentations.length > 0 ? `every value of ${plan.segmentations.map((seg) => seg.id).join(', ')} holds the sessions, orders, and revenue of segment all` : 'no segmentation to partition',
      conservation: Object.entries(totals).map(([name, total]) => `${name} totals ${round(total)} in the source rows of the reported periods and in the dataset`),
    },
    totals,
  };
}

const round = (value) => Number(value.toFixed(6));
