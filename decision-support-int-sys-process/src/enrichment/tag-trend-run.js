import { randomUUID } from 'node:crypto';
import { addDays } from '../triggers/time.js';
import { DEFAULT_LOOKBACK_DAYS, runInputs } from './segmentation-inputs.js';
import { groupParams, planGroups } from './segmentation-sql.js';
import { runVersions, stampVersions, versionNotes } from '../application/segmentation/versions.js';
import {
  backfillDays, backfillGroups, backfillNotes, changedSegmentations, checkBackfillWeeks, gridOf, markRetired,
} from './segmentation-backfill.js';
import { tagCellsOf, tagPairs, tagTrendRows, trendValuesOf, verifyTagTrend } from './tag-trend-aggregate.js';
import { tagInventorySql, tagTrendAggregateSql, tagValueStatsSql } from './tag-trend-sql.js';
import { weekStarts, wholeWeeks } from './trend-window.js';

export { DEFAULT_LOOKBACK_DAYS };

const SETTINGS = `
SETTINGS max_execution_time = 180,
         max_bytes_before_external_group_by = 2147483648,
         timeout_before_checking_execution_speed = 0`;

/**
 * Session-tag trend for one site. The selector adapter picks the keys and
 * values. A stored selection is kept unless `rerank` is set, so a week
 * reads against the same values as the week before it.
 *
 * @param {object} opts
 * @param {number} opts.idsite
 * @param {string} [opts.windowStart] with windowEnd, the window to read
 * @param {string} [opts.windowEnd]
 * @param {{today: string, overlapWeeks?: number, backfillWeeks?: number}} [opts.nextWeeks] in place of
 *   the window: read from the stored weeks to the last whole week before today
 * @param {number} [opts.lookbackDays] how far before a visit return intent reads
 * @param {ReadonlyArray<import('../ports/segmentation.js').Segmentation>} opts.segmentations what the rows are split by, in order
 * @param {number} [opts.segmentationBudget] the most segmentation values one query reads
 * @param {number} [opts.maxBackfillWeeks] the most stored weeks a changed segmentation rewrites without backfillAll
 * @param {boolean} [opts.backfillAll]
 * @param {boolean} [opts.rerank]
 * @param {import('../ports/session-tag-selector.js').SessionTagSelector} opts.selector
 * @param {import('../ports/dataset.js').QueryGateway} opts.gateway
 * @param {import('../ports/persistence/session-tag-store.js').SessionTagStore & import('../ports/persistence/trigger-store.js').TriggerStore} opts.persistence
 * @param {{info?: Function}} [opts.logger]
 */
export async function runTagTrend(opts) {
  if (!opts.segmentations?.length) throw new Error('runTagTrend needs the segmentations to read');
  const segmentations = opts.segmentations;
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const baseInputs = await runInputs(segmentations, { ...opts, lookbackDays });
  const versions = await runVersions(segmentations, baseInputs, opts);
  const ids = versionNotes(versions.resolved);
  const changes = await changedSegmentations(
    segmentations,
    versions.byId,
    (id) => opts.persistence.readTagTrendWeekRange(opts.idsite, id),
    (range) => range.keys,
  );
  checkBackfillWeeks(changes, { maxWeeks: opts.maxBackfillWeeks, all: opts.backfillAll === true, flag: '--backfill-all' });
  const grid = gridOf(segmentations, changes);
  const stored = await opts.persistence.readTagSelection(opts.idsite);
  const frozen = opts.rerank !== true && stored.length > 0;
  const window = opts.nextWeeks
    ? await nextTagWindow(opts, frozen ? stored.map((row) => row.tagKey) : null)
    : { windowStart: opts.windowStart, windowEnd: opts.windowEnd };
  const { weeks, start, end, edges } = wholeWeeks(window.windowStart, window.windowEnd);
  const params = { idsite: opts.idsite, w0: start, w1: end };
  const batchId = randomUUID();
  if (weeks.length === 0) {
    return { batchId, idsite: opts.idsite, window, weeks, edges, segmentations: ids, backfill: [], selector: opts.selector.id, frozen: false, selected: [], rejected: [], rows: 0, check: null };
  }

  opts.logger?.info?.({ idsite: opts.idsite, weeks, selector: opts.selector.id }, 'tag trend inventory');
  const inventory = (await opts.gateway.query(`${tagInventorySql()}${SETTINGS}`, params, 'trend:tag-inventory'))
    .map((row) => ({ key: String(row.tag_key), visits: Number(row.visits) || 0, distinctValues: Number(row.distinct_values) || 0 }));
  const screened = opts.selector.candidates(inventory);
  const candidates = screened.filter((row) => row.status === 'candidate');

  const stats = candidates.length === 0
    ? []
    : await opts.gateway.query(
      `${tagValueStatsSql()}${SETTINGS}`,
      { ...params, tagKeys: candidates.map((row) => row.key) },
      'trend:tag-values',
    );
  const total = stats.find((row) => row.kind === 'total');
  const sessions = Number(total?.sessions ?? 0);
  const values = stats.filter((row) => row.kind === 'value').map((row) => ({
    key: String(row.tag_key),
    value: String(row.tag_value),
    sessions: Number(row.sessions) || 0,
    buyers: Number(row.buyers) || 0,
    orders: Number(row.orders) || 0,
    revenue: Number(row.revenue) || 0,
    visitRevenueSq: Number(row.visit_revenue_sq) || 0,
    orderRevenueSq: Number(row.order_revenue_sq) || 0,
  }));
  const verdicts = [
    ...opts.selector.select({ candidates, values, sessions }),
    ...screened.filter((row) => row.status !== 'candidate'),
  ];

  const selection = frozen
    ? stored
    : verdicts
      .filter((row) => row.status === 'selected')
      .map((row) => ({ tagKey: row.key, family: row.family, trendValues: row.trendValues }));
  if (!frozen) {
    await opts.persistence.writeTagSelection(selectionRows(verdicts, { ...opts, windowStart: start, windowEnd: end, batchId }));
  }
  if (selection.length === 0) {
    return { batchId, idsite: opts.idsite, window, weeks, edges, segmentations: ids, backfill: [], selector: opts.selector.id, frozen, selected: [], rejected: rejectedOf(verdicts), rows: 0, check: null };
  }

  const inputs = { ...baseInputs, start };
  const groups = planGroups([...segmentations], opts.segmentationBudget);
  opts.logger?.info?.({ keys: selection.map((row) => row.tagKey), frozen, segmentations: ids, groups: groups.length }, 'tag trend scan');
  const cells = [];
  for (const [index, group] of groups.entries()) {
    const raw = await opts.gateway.query(
      `${tagTrendAggregateSql(group, inputs)}${SETTINGS}`,
      {
        ...params,
        ...groupParams(group, inputs),
        tagKeys: selection.map((row) => row.tagKey),
        tagPairs: tagPairs(selection),
      },
      groups.length > 1 ? `trend:tag-trend:g${index + 1}` : 'trend:tag-trend',
    );
    cells.push(...tagCellsOf(raw));
  }
  let rows = tagTrendRows(selection, weeks, { batchId, idsite: opts.idsite, cells, segmentations: grid });
  const check = verifyTagTrend(rows, selection, sessions, grid);

  /** @type {Map<string, {weeks: string[], rows: number}>} */
  const written = new Map();
  for (const change of changes) {
    const backfilled = await backfillTags(change, {
      stored,
      runStart: (tagKey) => (selection.some((row) => row.tagKey === tagKey) ? start : null),
      inputs: baseInputs,
      batchId,
      opts,
    });
    rows = rows.concat(backfilled);
    written.set(change.seg.id, { weeks: [...new Set(backfilled.map((row) => row.week))].sort(), rows: backfilled.length });
  }
  rows = markRetired(stampVersions(rows, versions.byId), changes);
  await opts.persistence.writeTagTrendRows(rows);
  await versions.record();
  return {
    batchId,
    idsite: opts.idsite,
    window,
    weeks,
    edges,
    selector: opts.selector.id,
    frozen,
    segmentations: ids,
    backfill: backfillNotes(changes, written),
    lookbackDays,
    sessions,
    selected: trendValuesOf(selection).map((row) => ({ key: row.tagKey, family: row.family, values: row.trendValues })),
    rejected: rejectedOf(verdicts),
    rows: rows.length,
    check,
  };
}

/**
 * One changed segmentation's rows over each stored key's weeks that this
 * run does not read, for the values the stored selection names, without
 * `all` rows. Keys that share a span share a query.
 * @param {import('./segmentation-backfill.js').SegmentationChange} change
 * @param {object} run
 */
async function backfillTags(change, { stored, runStart, inputs, batchId, opts }) {
  const selected = new Map(stored.map((row) => [row.tagKey, row]));
  /** @type {Map<string, {days: {w0: string, w1: string}, selection: object[]}>} */
  const spans = new Map();
  for (const key of change.range.keys) {
    const row = selected.get(key.tagKey);
    const days = row ? backfillDays(key, runStart(key.tagKey)) : null;
    if (!days) continue;
    const id = `${days.w0}|${days.w1}`;
    if (!spans.has(id)) spans.set(id, { days, selection: [] });
    spans.get(id).selection.push(row);
  }
  const grid = gridOf([change.seg], [change]);
  const groups = backfillGroups(change, opts.segmentationBudget);
  let rows = [];
  for (const { days, selection } of spans.values()) {
    const groupInputs = { ...inputs, start: days.w0 };
    opts.logger?.info?.({ segmentation: change.seg.id, from: change.previous, to: change.version, keys: selection.map((row) => row.tagKey), ...days }, 'tag trend backfill');
    const cells = [];
    for (const [index, group] of groups.entries()) {
      const raw = await opts.gateway.query(
        `${tagTrendAggregateSql(group, groupInputs)}${SETTINGS}`,
        {
          idsite: opts.idsite,
          ...days,
          ...groupParams(group, groupInputs),
          tagKeys: selection.map((row) => row.tagKey),
          tagPairs: tagPairs(selection),
        },
        groups.length > 1 ? `trend:backfill-tag-trend:g${index + 1}` : 'trend:backfill-tag-trend',
      );
      cells.push(...tagCellsOf(raw));
    }
    rows = rows.concat(tagTrendRows(selection, wholeWeeks(days.w0, days.w1).weeks, { batchId, idsite: opts.idsite, cells, segmentations: grid }));
  }
  return rows.filter((row) => row.segment === change.seg.id);
}

/**
 * One window for every key, since the check holds each key's weeks to the
 * window's kept sessions. A frozen selection starts at the earliest start
 * of its keys, and is current when every key is. A new selection starts at
 * the backfill, or earlier where a stored key would be left with a gap.
 * @param {object} opts runTagTrend options
 * @param {string[] | null} keys the frozen selection's keys
 */
async function nextTagWindow(opts, keys) {
  const stored = (await opts.persistence.readTagTrendWeeks(opts.idsite)).map((row) => ({ key: row.tagKey, week: row.week }));
  const starts = weekStarts(opts.nextWeeks, stored);
  const keyStarts = (keys ?? stored.map((row) => row.key)).map(starts.startOf);
  const floor = keys ? addDays(starts.end, 7) : starts.backfill;
  return { windowStart: keyStarts.reduce((least, start) => (start < least ? start : least), floor), windowEnd: starts.end };
}

/**
 * @param {import('../ports/session-tag-selector.js').TagKeyVerdict[]} verdicts
 * @param {{batchId: string, idsite: number, windowStart: string, windowEnd: string, selector: {id: string}}} run
 * @returns {import('../ports/persistence.js').AeSessionTagSelectionRow[]}
 */
export function selectionRows(verdicts, run) {
  return verdicts.map((row) => ({
    batchId: run.batchId,
    idsite: run.idsite,
    tagKey: row.key,
    adapterId: run.selector.id,
    family: row.family,
    status: row.status === 'selected' ? 'selected' : 'rejected',
    reason: row.reason,
    windowStart: run.windowStart,
    windowEnd: run.windowEnd,
    taggedSessions: row.taggedSessions,
    distinctValues: row.distinctValues,
    rpsZ: finite(row.rps?.z),
    rpsSpread: finite(row.rps?.spread),
    aovZ: finite(row.aov?.z),
    aovSpread: finite(row.aov?.spread),
    trendValues: row.trendValues ?? [],
    metrics: { rps: row.rps, aov: row.aov, values: row.values },
  }));
}

/** @param {import('../ports/session-tag-selector.js').TagKeyVerdict[]} verdicts */
function rejectedOf(verdicts) {
  return verdicts.filter((row) => row.status !== 'selected').map((row) => ({ key: row.key, reason: row.reason }));
}

/** @param {unknown} value */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
