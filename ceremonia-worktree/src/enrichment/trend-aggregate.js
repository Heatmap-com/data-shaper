/**
 * Pure rollup from segmented session cells onto ae_trend_row.
 *
 * A cell is one week, one device, and one (segment, value) pair: the `all`
 * total or one value of one segmentation. Segmentations are not crossed.
 * viewport_type is a column, so each pair is written for `all` and for its
 * device. A visit with no device type lands only on `all` plus a viewport
 * of `unknown` when that cell has sessions.
 */

import { buildTrendRow } from './trend-row.js';

export const DEFAULT_PATH_LIMIT = 3;
export const PAGE_LIMIT = 5;

const DEVICE_VIEWPORTS = ['desktop', 'tablet', 'mobile'];

/**
 * What the rollup needs of a segmentation: its id and every value it can
 * take. Every value gets a row, zero or not.
 * @typedef {{id: string, values: ReadonlyArray<string>}} SegmentationGrid
 */

/**
 * @param {Array<{path?: string, revenue?: number, sessions?: number}>} cells
 * @param {number} limit
 * @returns {string[]}
 */
export function rankMoneyPaths(cells, limit) {
  /** @type {Map<string, {path: string, revenue: number, sessions: number}>} */
  const totals = new Map();
  for (const cell of cells) {
    const path = String(cell.path ?? '');
    if (!path.includes(' > ')) continue;
    const current = totals.get(path) ?? { path, revenue: 0, sessions: 0 };
    current.revenue += Number(cell.revenue) || 0;
    current.sessions += Number(cell.sessions) || 0;
    totals.set(path, current);
  }
  return [...totals.values()]
    .sort((a, b) => b.revenue - a.revenue || b.sessions - a.sessions || (a.path < b.path ? -1 : 1))
    .slice(0, limit)
    .map((row) => row.path);
}

/**
 * Exact prefixes of the chosen paths, plus the ` > ` extension of each
 * full path, so a later page on that same URL sequence still counts.
 * @param {string[]} paths
 */
export function pathMatchList(paths) {
  /** @type {Set<string>} */
  const exact = new Set();
  /** @type {string[]} */
  const extensions = [];
  for (const path of paths) {
    const parts = path.split(' > ');
    for (let i = 1; i <= parts.length; i += 1) exact.add(parts.slice(0, i).join(' > '));
    extensions.push(`${path} > `);
  }
  return { exact: [...exact], extensions };
}

/**
 * The subject list: the ranked list on a rerank, else the stored list in
 * its stored order, filled from the ranked list up to `limit`. A stored
 * subject keeps its place, so its rank stays as written.
 * @param {string[]} existing
 * @param {string[]} ranked
 * @param {boolean} rerank
 * @param {number} limit
 */
export function chooseSubjects(existing, ranked, rerank, limit) {
  if (rerank) return ranked.slice(0, limit);
  const kept = existing.slice(0, limit);
  return [...kept, ...ranked.filter((subject) => !kept.includes(subject))].slice(0, limit);
}

/**
 * @param {string} path
 * @param {string[]} templates
 * @param {number} index
 */
export function onStep(path, templates, index) {
  const prefix = templates.slice(0, index + 1).join(' > ');
  const next = templates[index + 1];
  if (path === prefix) return true;
  if (next) return path.startsWith(`${prefix} > ${next}`);
  return path.startsWith(`${prefix} > `);
}

/**
 * @param {string} path
 * @param {string[]} templates
 * @param {number} index
 */
export function reachedNext(path, templates, index) {
  if (index + 1 >= templates.length) return false;
  const prefix = templates.slice(0, index + 2).join(' > ');
  return path === prefix || path.startsWith(`${prefix} > `);
}

/**
 * @param {object} spec
 * @param {Array<object>} spec.cells
 * @param {string[]} spec.weeks
 * @param {string} spec.batchId
 * @param {number} spec.idsite
 * @param {Array<{rowType: string, rowKey: string, rowKey1: string, rowKey2: string, idsitehsr: number, metrics?: object, accept: (cell: object) => boolean, progressed: (cell: object) => number}>} spec.subjects
 * @param {SegmentationGrid[]} spec.segmentations
 * @param {(subject: object, cell: object, index: number) => object} [spec.build] one stored row from a filled bucket
 */
export function expandTrendRows(spec) {
  if (!Array.isArray(spec.segmentations)) throw new Error('expandTrendRows needs the run\'s segmentations');
  const build = spec.build ?? ((subject, filled, index) => buildTrendRow({
    batchId: spec.batchId,
    idsite: spec.idsite,
    idsitehsr: subject.idsitehsr,
    rowType: subject.rowType,
    rowKey: subject.rowKey,
    rowKey1: subject.rowKey1,
    rowKey2: subject.rowKey2,
    ...filled,
    metrics: { rank: index + 1, ...(subject.metrics ?? {}) },
  }));
  const rows = [];
  for (const [index, subject] of spec.subjects.entries()) {
    const buckets = emptyGrid(spec.weeks, spec.segmentations);
    for (const cell of spec.cells) {
      if (!subject.accept(cell)) continue;
      const progressed = subject.progressed(cell);
      const viewports = cell.viewport === 'unknown' || !DEVICE_VIEWPORTS.includes(cell.viewport)
        ? ['all', 'unknown']
        : ['all', cell.viewport];
      for (const viewport of viewports) {
        const key = `${cell.week}|${viewport}|${cell.segment}|${cell.segmentValue}`;
        const bucket = buckets.get(key) ?? blank();
        add(bucket, cell, progressed);
        buckets.set(key, bucket);
      }
    }
    for (const [key, bucket] of buckets) {
      const [week, viewport, segment, segmentValue] = key.split('|');
      rows.push(build(subject, {
        viewportType: viewport,
        segment,
        segmentValue,
        week,
        sessions: bucket.sessions,
        buyers: bucket.buyers,
        orders: bucket.orders,
        revenue: Math.round(bucket.revenue * 100) / 100,
        clicks: bucket.clicks,
        progressed: bucket.progressed,
      }, index));
    }
  }
  return rows;
}

/**
 * @param {string[]} paths
 * @param {string[]} weeks
 * @param {{batchId: string, idsite: number, cells: object[], segmentations: SegmentationGrid[]}} base
 * @param {{pathKey?: string, stepKey?: string, field?: string}} [keys]
 */
export function journeyRows(paths, weeks, base, keys = {}) {
  const pathKey = keys.pathKey ?? 'path';
  const stepKey = keys.stepKey ?? 'step';
  const field = keys.field ?? 'path';
  /** @type {Array<object>} */
  const subjects = [];
  paths.forEach((path, index) => {
    const templates = path.split(' > ');
    subjects.push({
      rowType: 'journey',
      rowKey: pathKey,
      rowKey1: path,
      rowKey2: '',
      idsitehsr: 0,
      metrics: { rank: index + 1 },
      accept: (cell) => cell[field] === path,
      progressed: (cell) => Number(cell.progressed) || 0,
    });
    templates.forEach((step, stepIndex) => {
      const last = stepIndex === templates.length - 1;
      subjects.push({
        rowType: 'journey',
        rowKey: stepKey,
        rowKey1: `${stepIndex + 1}:${step}`,
        rowKey2: path,
        idsitehsr: 0,
        metrics: { rank: index + 1, step_index: stepIndex + 1 },
        accept: (cell) => onStep(String(cell[field] ?? ''), templates, stepIndex),
        progressed: (cell) => (
          last
            ? (Number(cell.progressed) || 0)
            : (reachedNext(String(cell[field] ?? ''), templates, stepIndex) ? (Number(cell.sessions) || 0) : 0)
        ),
      });
    });
  });
  return expandTrendRows({ ...base, weeks, subjects });
}

/**
 * @param {Array<{idsitehsr: string, url: string}>} pages
 * @param {string[]} weeks
 * @param {{batchId: string, idsite: number, cells: object[], segmentations: SegmentationGrid[]}} base
 */
export function pageRows(pages, weeks, base) {
  const subjects = pages.map((page) => ({
    rowType: 'page',
    rowKey: 'page',
    rowKey1: String(page.idsitehsr),
    rowKey2: page.url ?? '',
    idsitehsr: Number(page.idsitehsr),
    accept: (cell) => String(cell.idsitehsr) === String(page.idsitehsr),
    progressed: (cell) => Number(cell.progressed) || 0,
  }));
  return expandTrendRows({ ...base, weeks, subjects });
}

/**
 * @param {string[]} selectors
 * @param {number} idsitehsr
 * @param {string[]} weeks
 * @param {{batchId: string, idsite: number, cells: object[], segmentations: SegmentationGrid[]}} base
 */
export function selectorRows(selectors, idsitehsr, weeks, base) {
  const subjects = selectors.map((selector) => ({
    rowType: 'element',
    rowKey: 'selector',
    rowKey1: selector,
    rowKey2: '',
    idsitehsr,
    metrics: { attribution: 'correlational' },
    accept: (cell) => cell.selector === selector,
    progressed: (cell) => Number(cell.progressed) || 0,
  }));
  return expandTrendRows({ ...base, weeks, subjects });
}

/**
 * @param {import('../ports/persistence.js').AeTrendSelectorRow[]} rows
 */
export function activeSelectorPages(rows) {
  return rows.filter((row) => row.status === 'active' && (row.trendSelectors?.length ?? 0) > 0);
}

/**
 * @param {string[]} weeks
 * @param {SegmentationGrid[]} segmentations
 */
function emptyGrid(weeks, segmentations) {
  /** @type {Map<string, ReturnType<typeof blank>>} */
  const buckets = new Map();
  const segments = [
    ['all', 'all'],
    ...segmentations.flatMap((seg) => seg.values.map((value) => [seg.id, value])),
  ];
  for (const week of weeks) {
    for (const viewport of ['all', ...DEVICE_VIEWPORTS]) {
      for (const [segment, segmentValue] of segments) {
        buckets.set(`${week}|${viewport}|${segment}|${segmentValue}`, blank());
      }
    }
  }
  return buckets;
}

function blank() {
  return { sessions: 0, buyers: 0, orders: 0, revenue: 0, clicks: 0, progressed: 0 };
}

/**
 * @param {ReturnType<typeof blank>} bucket
 * @param {object} cell
 * @param {number} progressed
 */
function add(bucket, cell, progressed) {
  bucket.sessions += Number(cell.sessions) || 0;
  bucket.buyers += Number(cell.buyers) || 0;
  bucket.orders += Number(cell.orders) || 0;
  bucket.revenue += Number(cell.revenue) || 0;
  bucket.clicks += Number(cell.clicks) || 0;
  bucket.progressed += progressed;
}
