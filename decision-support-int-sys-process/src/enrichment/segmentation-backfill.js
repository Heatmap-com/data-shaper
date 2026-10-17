import { addDays } from '../triggers/time.js';
import { planGroups } from './segmentation-sql.js';
import { wholeWeeks } from './trend-window.js';

export const DEFAULT_MAX_BACKFILL_WEEKS = 26;

/**
 * @typedef {Object} SegmentationChange
 * @property {import('../ports/segmentation.js').Segmentation} seg
 * @property {number} previous the version the stored rows carry
 * @property {number} version
 * @property {Array<{first: string, last: string}>} spans the stored weeks it covers, per subject
 * @property {object} range what the store returned
 * @property {string[]} retired stored values the new definition no longer has
 */

/**
 * The run's changed segmentations and what the site has stored for each.
 * A changed segmentation with nothing stored has nothing to rewrite.
 * @param {ReadonlyArray<import('../ports/segmentation.js').Segmentation>} segmentations
 * @param {Map<string, {changed: boolean, previous: number | null, version: number}>} byId
 * @param {(segment: string) => Promise<{values: string[]}>} readRange
 * @param {(range: object) => Array<{first: string, last: string}>} spansOf
 * @returns {Promise<SegmentationChange[]>}
 */
export async function changedSegmentations(segmentations, byId, readRange, spansOf) {
  /** @type {SegmentationChange[]} */
  const changes = [];
  for (const seg of segmentations) {
    const resolved = byId.get(seg.id);
    if (!resolved?.changed) continue;
    const range = await readRange(seg.id);
    const spans = spansOf(range);
    if (spans.length === 0) continue;
    const retired = range.values.filter((value) => !seg.values.includes(value));
    changes.push({ seg, previous: Number(resolved.previous), version: resolved.version, spans, range, retired });
  }
  return changes;
}

/**
 * Refuses a backfill longer than the limit unless every week is asked for,
 * so an accidental edit does not rescan a year. Checked before any query.
 * @param {SegmentationChange[]} changes
 * @param {{maxWeeks?: number, all?: boolean, flag: string}} limit
 */
export function checkBackfillWeeks(changes, { maxWeeks = DEFAULT_MAX_BACKFILL_WEEKS, all = false, flag }) {
  if (all) return;
  for (const change of changes) {
    const { first, last, weeks } = spanWeeks(change.spans);
    if (weeks > maxWeeks) {
      throw new Error(
        `segmentation ${change.seg.id} moved from version ${change.previous} to ${change.version}: its stored rows `
        + `cover ${weeks} weeks, ${first} to ${last}, over the backfill limit of ${maxWeeks}; pass ${flag} to rewrite them`,
      );
    }
  }
}

/** @param {Array<{first: string, last: string}>} spans */
export function spanWeeks(spans) {
  const first = spans.reduce((least, span) => (span.first < least ? span.first : least), spans[0].first);
  const last = spans.reduce((most, span) => (span.last > most ? span.last : most), spans[0].last);
  return { first, last, weeks: wholeWeeks(first, addDays(last, 6)).weeks.length };
}

/**
 * The value grid rows are built over: each changed segmentation keeps its
 * retired values, so they get zero rows and the partition still holds.
 * @param {ReadonlyArray<import('../ports/segmentation.js').Segmentation>} segmentations
 * @param {SegmentationChange[]} changes
 * @returns {import('./trend-aggregate.js').SegmentationGrid[]}
 */
export function gridOf(segmentations, changes) {
  const retired = new Map(changes.map((change) => [change.seg.id, change.retired]));
  return segmentations.map((seg) => ({ id: seg.id, values: [...seg.values, ...(retired.get(seg.id) ?? [])] }));
}

/**
 * Marks the zero rows of retired values with `metrics.retired`.
 * @template {{segment: string, segmentValue: string, metrics?: object}} T
 * @param {T[]} rows
 * @param {SegmentationChange[]} changes
 * @returns {T[]}
 */
export function markRetired(rows, changes) {
  const retired = new Map(changes.filter((change) => change.retired.length > 0).map((change) => [change.seg.id, new Set(change.retired)]));
  if (retired.size === 0) return rows;
  return rows.map((row) => (
    retired.get(row.segment)?.has(row.segmentValue) ? { ...row, metrics: { ...(row.metrics ?? {}), retired: true } } : row
  ));
}

/**
 * The query groups of a backfill: the changed segmentation alone, without
 * the `all` tuple, since `all` did not change.
 * @param {SegmentationChange} change
 * @param {number} [budget]
 */
export function backfillGroups(change, budget) {
  return planGroups([change.seg], budget).map((group) => ({ ...group, withAll: false }));
}

/**
 * The days a stored subject's backfill reads: its stored weeks, ending the
 * day before the run reads it, so no week is read twice.
 * @param {{first: string, last: string}} span
 * @param {string | null} runStart the first day this run reads the subject, if it does
 * @returns {{w0: string, w1: string} | null}
 */
export function backfillDays(span, runStart) {
  const lastDay = addDays(span.last, 6);
  const w1 = runStart && runStart <= lastDay ? addDays(runStart, -1) : lastDay;
  return w1 < span.first ? null : { w0: span.first, w1 };
}

/**
 * The run note for each change.
 * @param {SegmentationChange[]} changes
 * @param {Map<string, {weeks: string[], rows: number}>} written
 */
export function backfillNotes(changes, written) {
  return changes.map((change) => {
    const done = written.get(change.seg.id) ?? { weeks: [], rows: 0 };
    return {
      id: change.seg.id,
      from: change.previous,
      to: change.version,
      weeks: done.weeks.length === 0 ? null : [done.weeks[0], done.weeks[done.weeks.length - 1]],
      rows: done.rows,
      retired: change.retired,
    };
  });
}
