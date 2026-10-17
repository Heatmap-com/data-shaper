/**
 * Pure rollup from segmented tag cells onto ae_session_tag_trend. A cell is
 * one week, one device, one (segment, value) pair, one tag key, and one
 * trend value of that key. Segmentations are not crossed.
 */

import { expandTrendRows } from './trend-aggregate.js';
import { buildTagTrendRow } from './trend-row.js';
import { PAIR_SEPARATOR } from './tag-trend-sql.js';

export const NONE_VALUE = '(none)';
export const OTHER_VALUE = 'other';

/**
 * A selected value named like a rollup bucket would merge into it, so it
 * stays in `other`.
 * @param {Array<{tagKey: string, trendValues: string[]}>} selection
 */
export function trendValuesOf(selection) {
  return selection.map((row) => ({
    ...row,
    trendValues: row.trendValues.filter((value) => value !== NONE_VALUE && value !== OTHER_VALUE),
  }));
}

/**
 * @param {Array<{tagKey: string, trendValues: string[]}>} selection
 * @returns {string[]} `key` + separator + `value`, the SQL membership list
 */
export function tagPairs(selection) {
  return trendValuesOf(selection).flatMap((row) => row.trendValues.map((value) => `${row.tagKey}${PAIR_SEPARATOR}${value}`));
}

/**
 * @param {Array<{tagKey: string, family?: string, trendValues: string[]}>} selection
 * @param {string[]} weeks
 * @param {{batchId: string, idsite: number, cells: object[], segmentations: import('./trend-aggregate.js').SegmentationGrid[]}} base
 */
export function tagTrendRows(selection, weeks, base) {
  const subjects = trendValuesOf(selection).flatMap((row) => (
    [...row.trendValues, OTHER_VALUE, NONE_VALUE].map((tagValue, rank) => ({
      tagKey: row.tagKey,
      tagValue,
      metrics: { family: row.family ?? '', rank: rank + 1 },
      accept: (cell) => cell.tagKey === row.tagKey && cell.tagValue === tagValue,
      progressed: (cell) => Number(cell.progressed) || 0,
    }))
  ));
  return expandTrendRows({
    cells: base.cells,
    weeks,
    subjects,
    segmentations: base.segmentations,
    build: (subject, filled) => buildTagTrendRow({
      batchId: base.batchId,
      idsite: base.idsite,
      tagKey: subject.tagKey,
      tagValue: subject.tagValue,
      ...filled,
      metrics: subject.metrics,
    }),
  });
}

/**
 * @param {object[]} raw tagTrendAggregateSql rows
 */
export function tagCellsOf(raw) {
  return raw.map((row) => ({
    week: String(row.week_start).slice(0, 10),
    viewport: String(row.viewport_value),
    segment: String(row.segment),
    segmentValue: String(row.segment_value),
    tagKey: String(row.key_value),
    tagValue: String(row.trend_value),
    sessions: Number(row.sessions),
    buyers: Number(row.buyers),
    orders: Number(row.orders),
    revenue: Number(row.revenue),
    clicks: 0,
    progressed: Number(row.progressed),
  }));
}

/**
 * Every key holds every kept session once, so each key's values add up to
 * the window total. Each segmentation partitions its `all` row.
 * @param {import('../ports/persistence.js').AeSessionTagTrendRow[]} rows
 * @param {Array<{tagKey: string, trendValues: string[]}>} selection
 * @param {number | null | undefined} expectedSessions kept sessions in the window
 * @param {import('./trend-aggregate.js').SegmentationGrid[]} segmentations
 */
export function verifyTagTrend(rows, selection, expectedSessions, segmentations) {
  /** @type {string[]} */
  const errors = [];
  const totals = (row) => row.viewportType === 'all' && row.segment === 'all' && row.segmentValue === 'all';
  for (const row of trendValuesOf(selection)) {
    const keyRows = rows.filter((item) => item.tagKey === row.tagKey);
    const stored = new Set(keyRows.map((item) => item.tagValue));
    for (const value of [...row.trendValues, OTHER_VALUE, NONE_VALUE]) {
      if (!stored.has(value)) errors.push(`${row.tagKey} has no rows for ${value}`);
    }
    const sessions = keyRows.filter(totals).reduce((sum, item) => sum + item.sessions, 0);
    if (expectedSessions != null && sessions !== expectedSessions) {
      errors.push(`${row.tagKey} sessions ${sessions}, expected ${expectedSessions}`);
    }
    const sample = keyRows.find((item) => totals(item) && item.sessions > 0);
    if (!sample) continue;
    for (const seg of segmentations) {
      const parts = keyRows.filter((item) => (
        item.tagValue === sample.tagValue
        && item.week === sample.week
        && item.viewportType === 'all'
        && item.segment === seg.id
      ));
      const sum = parts.reduce((acc, item) => acc + item.sessions, 0);
      if (sum !== sample.sessions) {
        errors.push(`${row.tagKey}=${sample.tagValue} ${seg.id} sessions ${sum} do not add up to ${sample.sessions}`);
      }
    }
  }
  if (errors.length > 0) throw new Error(`tag trend check failed: ${errors.join('; ')}`);
  return { ok: true, keys: selection.length, rows: rows.length };
}
