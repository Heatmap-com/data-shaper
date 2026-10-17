import { randomUUID } from 'node:crypto';
import { addDays } from '../triggers/time.js';
import { byStart, weekStarts, wholeWeeks } from './trend-window.js';
import { groupParams, planGroups } from './segmentation-sql.js';
import { runInputs } from './segmentation-inputs.js';
import { runVersions, stampVersions, versionNotes } from '../application/segmentation/versions.js';
import {
  backfillDays, backfillGroups, backfillNotes, changedSegmentations, checkBackfillWeeks, gridOf, markRetired,
} from './segmentation-backfill.js';
import {
  DEFAULT_PATH_LIMIT,
  PAGE_LIMIT,
  activeSelectorPages,
  chooseSubjects,
  journeyRows,
  pageRows,
  pathMatchList,
  rankMoneyPaths,
  selectorRows,
} from './trend-aggregate.js';
import {
  pageAggregateSql,
  pageRankSql,
  pageUrlSql,
  pathAggregateSql,
  pathRankSql,
  selectorAggregateSql,
} from './trend-sql.js';

const SETTINGS = `
SETTINGS max_execution_time = 180,
         max_bytes_before_external_group_by = 2147483648,
         timeout_before_checking_execution_speed = 0`;

export const DEFAULT_RANK_DAYS = 30;

/** The key `readTrendWeeks` names a subject by. */
const subjectKey = (rowKey, rowKey1, idsitehsr = 0) => `${rowKey}|${Number(idsitehsr)}|${rowKey1}`;

/** The subject a row belongs to: a step row belongs to its path. */
function rowSubject(row) {
  if (row.rowKey === 'step') return subjectKey('path', row.rowKey2, 0);
  if (row.rowKey === 'url_step') return subjectKey('url_path', row.rowKey2, 0);
  return subjectKey(row.rowKey, row.rowKey1, row.idsitehsr ?? 0);
}

/**
 * Where the run ranks and where each subject starts. An explicit window
 * gives every subject its first whole Monday. `nextWeeks` starts each
 * subject from its own stored weeks.
 * @param {object} opts runTrend options
 */
async function weekPlan(opts) {
  const rankOf = (end) => ({ w0: addDays(end, 1 - (opts.rankDays ?? DEFAULT_RANK_DAYS)), w1: end });
  if (!opts.nextWeeks) {
    const { start, end } = wholeWeeks(opts.windowStart, opts.windowEnd);
    return { empty: start > end, rank: rankOf(end), end, startOf: () => start, window: { windowStart: opts.windowStart, windowEnd: opts.windowEnd } };
  }
  const stored = (await opts.persistence.readTrendWeeks(opts.idsite))
    .map((row) => ({ key: subjectKey(row.rowKey, row.rowKey1, row.idsitehsr), week: row.week }));
  const starts = weekStarts(opts.nextWeeks, stored);
  return { empty: false, rank: rankOf(starts.end), end: starts.end, startOf: starts.startOf, window: null };
}

/**
 * @param {object} opts
 * @param {number} opts.idsite
 * @param {string} [opts.windowStart] with windowEnd, the window to read
 * @param {string} [opts.windowEnd]
 * @param {{today: string, overlapWeeks?: number, backfillWeeks?: number}} [opts.nextWeeks] in place of
 *   the window: each subject reads from its stored weeks to the last whole week before today
 * @param {number} [opts.pathLimit]
 * @param {boolean} [opts.rerank]
 * @param {number} [opts.rankDays] the days ending on the last week the rank reads; it runs on a
 *   rerank, or when a stored list is short of its limit
 * @param {import('../ports/persistence.js').AeTrendSelectorRow[]} [opts.seeds] selector rows written for pages
 *   the site has no trend selectors for yet; rows for other sites are ignored
 * @param {ReadonlyArray<import('../ports/segmentation.js').Segmentation>} opts.segmentations what the rows are split by, in order
 * @param {number} [opts.segmentationBudget] the most segmentation values one query reads
 * @param {number} [opts.lookbackDays] how far before a visit return intent reads, when it is selected
 * @param {number} [opts.maxBackfillWeeks] the most stored weeks a changed segmentation rewrites without backfillAll
 * @param {boolean} [opts.backfillAll]
 * @param {import('../ports/dataset.js').QueryGateway} opts.gateway
 * @param {import('../ports/persistence/trend-store.js').TrendStore} opts.persistence
 * @param {{info?: Function}} [opts.logger]
 */
export async function runTrend(opts) {
  if (!opts.segmentations?.length) throw new Error('runTrend needs the segmentations to read');
  const pathLimit = opts.pathLimit ?? DEFAULT_PATH_LIMIT;
  const batchId = randomUUID();
  const segmentations = opts.segmentations;
  const groups = planGroups([...segmentations], opts.segmentationBudget);
  const inputs = await runInputs(segmentations, opts);
  const versions = await runVersions(segmentations, inputs, opts);
  const changes = await changedSegmentations(
    segmentations,
    versions.byId,
    (id) => opts.persistence.readTrendWeekRange(opts.idsite, id),
    (range) => range.subjects,
  );
  checkBackfillWeeks(changes, { maxWeeks: opts.maxBackfillWeeks, all: opts.backfillAll === true, flag: '--backfill-all' });
  const grid = gridOf(segmentations, changes);
  const plan = await weekPlan(opts);
  const nothing = (window) => {
    const { weeks, edges } = wholeWeeks(window.windowStart, window.windowEnd);
    return { batchId, idsite: opts.idsite, window, weeks, edges, segmentations: versionNotes(versions.resolved), backfill: [], paths: [], urlPaths: [], pages: [], selectors: [], rows: 0, check: null };
  };
  if (plan.empty) return nothing(plan.window);
  const rankParams = { idsite: opts.idsite, ...plan.rank };

  await seedMissingSelectors(opts.persistence, opts.idsite, opts.seeds ?? []);
  const config = await opts.persistence.readTrendSelectors(opts.idsite);
  const selectorPages = activeSelectorPages(config);
  const existing = await opts.persistence.readTrendSubjects(opts.idsite);
  const rerank = opts.rerank === true;
  const storedUrlPaths = existing.urlPaths ?? [];

  /** @type {Array<{kind: string, path: string, sessions: number, revenue: number}>} */
  let ranked = [];
  if (rerank || existing.paths.length < pathLimit || storedUrlPaths.length < pathLimit) {
    opts.logger?.info?.({ idsite: opts.idsite, rank: plan.rank }, 'trend rank paths');
    ranked = (await opts.gateway.query(`${pathRankSql()}${SETTINGS}`, rankParams, 'trend:path-rank'))
      .map((row) => ({
        kind: String(row.kind),
        path: String(row.path ?? ''),
        sessions: Number(row.sessions) || 0,
        revenue: Number(row.revenue) || 0,
      }));
  }
  const paths = chooseSubjects(existing.paths, rankMoneyPaths(ranked.filter((row) => row.kind === 'template'), pathLimit), rerank, pathLimit);
  const urlPaths = chooseSubjects(storedUrlPaths, rankMoneyPaths(ranked.filter((row) => row.kind === 'url'), pathLimit), rerank, pathLimit);

  /** @type {string[]} */
  let rankedPages = [];
  if (rerank || existing.pages.length < PAGE_LIMIT) {
    opts.logger?.info?.({ idsite: opts.idsite, rank: plan.rank }, 'trend rank pages');
    rankedPages = (await opts.gateway.query(
      `${pageRankSql()}${SETTINGS}`,
      { ...rankParams, pageLimit: PAGE_LIMIT },
      'trend:page-rank',
    )).map((row) => String(row.idsitehsr));
  }
  const pageIds = chooseSubjects(existing.pages, rankedPages, rerank, PAGE_LIMIT);

  const { end } = plan;
  const startOfPath = (path) => plan.startOf(subjectKey('path', path, 0));
  const startOfUrlPath = (path) => plan.startOf(subjectKey('url_path', path, 0));
  const startOfPage = (id) => plan.startOf(subjectKey('page', id, Number(id)));
  const startOfSelector = (idsitehsr) => (selector) => plan.startOf(subjectKey('selector', selector, idsitehsr));
  const starts = [
    ...paths.map(startOfPath),
    ...urlPaths.map(startOfUrlPath),
    ...pageIds.map(startOfPage),
    ...selectorPages.flatMap((page) => page.trendSelectors.map(startOfSelector(page.idsitehsr))),
  ];
  const window = plan.window ?? { windowStart: starts.reduce((least, start) => (start < least ? start : least), addDays(end, 7)), windowEnd: end };
  const { weeks, edges } = wholeWeeks(window.windowStart, window.windowEnd);
  if (weeks.length === 0) return nothing(window);
  const span = (start) => ({ idsite: opts.idsite, w0: start, w1: end });
  /**
   * Every query group's cells for one span, one query per group.
   * @param {import('./segmentation-sql.js').QueryGroup[]} queryGroups
   */
  const segmentedBy = (queryGroups) => async (sqlOf, params, label, field) => {
    const cells = [];
    for (const [index, group] of queryGroups.entries()) {
      const groupInputs = { ...inputs, start: params.w0 };
      const raw = await opts.gateway.query(
        `${sqlOf(group, groupInputs)}${SETTINGS}`,
        { ...params, ...groupParams(group, groupInputs) },
        queryGroups.length > 1 ? `${label}:g${index + 1}` : label,
      );
      for (const cell of cellsOf(raw, field)) cells.push(cell);
    }
    return cells;
  };
  const segmented = segmentedBy(groups);

  opts.logger?.info?.({ paths, urlPaths, weeks, segmentations: segmentations.map((seg) => seg.id), groups: groups.length }, 'trend scan paths');
  const templateCells = await groupedCells(byStart(paths, startOfPath, end), (start, group) => pathCellsOf(segmented, span(start), 'template', group, 'trend:paths'));
  const urlCells = await groupedCells(byStart(urlPaths, startOfUrlPath, end), (start, group) => pathCellsOf(segmented, span(start), 'url', group, 'trend:url-paths'));

  const pageGroups = byStart(pageIds, startOfPage, end);
  /** @type {Map<string, string>} */
  const urls = new Map();
  const pageCells = await groupedCells(pageGroups, async (start, group) => {
    opts.logger?.info?.({ pages: group, start }, 'trend scan pages');
    return segmented(pageAggregateSql, { ...span(start), pages: group.map(Number) }, 'trend:pages');
  });
  if (pageGroups.length > 0) {
    const written = pageGroups.flatMap(([, group]) => group);
    const urlRows = await opts.gateway.query(pageUrlSql(), { ...span(window.windowStart), pages: written.map(Number) }, 'trend:page-urls');
    for (const row of urlRows) urls.set(String(row.idsitehsr), String(row.url ?? ''));
  }

  const base = { batchId, idsite: opts.idsite, cells: templateCells, segmentations: grid };
  /** @type {import('../ports/persistence.js').AeTrendRow[]} */
  let rows = [
    ...journeyRows(paths, weeks, base),
    ...journeyRows(urlPaths, weeks, { ...base, cells: urlCells }, {
      pathKey: 'url_path',
      stepKey: 'url_step',
      field: 'urlPath',
    }),
    ...pageRows(pageIds.map((idsitehsr) => ({ idsitehsr, url: urls.get(idsitehsr) ?? '' })), weeks, { ...base, cells: pageCells }),
  ];

  /** @type {Array<{idsitehsr: number, selectors: string[]}>} */
  const selectorPlan = [];
  for (const page of selectorPages) {
    const startGroups = byStart(page.trendSelectors, startOfSelector(page.idsitehsr), end);
    if (startGroups.length === 0) continue;
    opts.logger?.info?.({ idsitehsr: page.idsitehsr, selectors: page.trendSelectors.length, groups: startGroups.length }, 'trend scan selectors');
    const cells = await groupedCells(startGroups, (start, group) => segmented(
      selectorAggregateSql,
      { ...span(start), idsitehsr: page.idsitehsr, selectors: group },
      'trend:selectors',
    ));
    const written = startGroups.flatMap(([, group]) => group);
    rows = rows.concat(selectorRows(written, page.idsitehsr, weeks, { ...base, cells }));
    selectorPlan.push({ idsitehsr: page.idsitehsr, selectors: written });
  }

  rows = rows.filter((row) => row.week >= plan.startOf(rowSubject(row)));
  const check = verifyTrend(rows, {
    paths: paths.filter((path) => startOfPath(path) <= end),
    urlPaths: urlPaths.filter((path) => startOfUrlPath(path) <= end),
    pages: pageIds.filter((id) => startOfPage(id) <= end),
    selectorPlan,
    segmentations: grid,
  });

  const runStartOf = (subject) => {
    const reads = (list, start) => (list.includes(subject.rowKey1) && start <= end ? start : null);
    if (subject.rowKey === 'path') return reads(paths, startOfPath(subject.rowKey1));
    if (subject.rowKey === 'url_path') return reads(urlPaths, startOfUrlPath(subject.rowKey1));
    if (subject.rowKey === 'page') return reads(pageIds, startOfPage(subject.rowKey1));
    const page = selectorPlan.find((entry) => entry.idsitehsr === subject.idsitehsr);
    return page ? reads(page.selectors, startOfSelector(subject.idsitehsr)(subject.rowKey1)) : null;
  };
  /** @type {Map<string, {weeks: string[], rows: number}>} */
  const written = new Map();
  for (const change of changes) {
    const backfilled = await backfillTrend(change, {
      runStartOf,
      read: segmentedBy(backfillGroups(change, opts.segmentationBudget)),
      order: { path: paths, url_path: urlPaths },
      base: { batchId, idsite: opts.idsite },
      logger: opts.logger,
    });
    rows = rows.concat(backfilled);
    written.set(change.seg.id, { weeks: [...new Set(backfilled.map((row) => row.week))].sort(), rows: backfilled.length });
  }
  rows = markRetired(stampVersions(rows, versions.byId), changes);
  await opts.persistence.writeTrendRows(rows);
  await versions.record();
  return {
    batchId,
    idsite: opts.idsite,
    window,
    weeks,
    edges,
    segmentations: versionNotes(versions.resolved),
    backfill: backfillNotes(changes, written),
    paths,
    urlPaths,
    pages: pageIds.map((idsitehsr) => ({ idsitehsr, url: urls.get(idsitehsr) ?? '' })),
    selectors: selectorPlan,
    rows: rows.length,
    check,
  };
}

/**
 * One changed segmentation's rows over each stored subject's weeks that
 * this run does not read, without `all` rows. Subjects that share a span
 * share a query.
 * @param {import('./segmentation-backfill.js').SegmentationChange} change
 * @param {object} run
 * @param {(subject: object) => string | null} run.runStartOf
 * @param {Function} run.read the backfill's per-group query
 * @param {{path: string[], url_path: string[]}} run.order the run's path order, which ranks
 * @param {{batchId: string, idsite: number}} run.base
 */
async function backfillTrend(change, run) {
  /** @type {Map<string, {kind: string, idsitehsr: number, days: {w0: string, w1: string}, subjects: object[]}>} */
  const spans = new Map();
  for (const subject of change.range.subjects) {
    const days = backfillDays(subject, run.runStartOf(subject));
    if (!days) continue;
    const key = [subject.rowKey, subject.idsitehsr, days.w0, days.w1].join('|');
    if (!spans.has(key)) spans.set(key, { kind: subject.rowKey, idsitehsr: subject.idsitehsr, days, subjects: [] });
    spans.get(key).subjects.push(subject);
  }
  const grid = gridOf([change.seg], [change]);
  let rows = [];
  for (const { kind, idsitehsr, days, subjects } of spans.values()) {
    const params = { idsite: run.base.idsite, ...days };
    const { weeks } = wholeWeeks(days.w0, days.w1);
    const names = subjects.map((subject) => subject.rowKey1);
    run.logger?.info?.({ segmentation: change.seg.id, from: change.previous, to: change.version, kind, subjects: names.length, ...days }, 'trend backfill');
    const base = (cells) => ({ ...run.base, cells, segmentations: grid });
    if (kind === 'path' || kind === 'url_path') {
      const url = kind === 'url_path';
      const cells = await pathCellsOf(run.read, params, url ? 'url' : 'template', names, url ? 'trend:backfill-url-paths' : 'trend:backfill-paths');
      const order = [...run.order[kind], ...names.filter((name) => !run.order[kind].includes(name))];
      const keys = url ? { pathKey: 'url_path', stepKey: 'url_step', field: 'urlPath' } : {};
      const named = new Set(names);
      rows = rows.concat(journeyRows(order, weeks, base(cells), keys)
        .filter((row) => named.has(row.rowKey === kind ? row.rowKey1 : row.rowKey2)));
    } else if (kind === 'page') {
      const cells = await run.read(pageAggregateSql, { ...params, pages: names.map(Number) }, 'trend:backfill-pages');
      rows = rows.concat(pageRows(subjects.map((subject) => ({ idsitehsr: subject.rowKey1, url: subject.rowKey2 })), weeks, base(cells)));
    } else {
      const cells = await run.read(selectorAggregateSql, { ...params, idsitehsr, selectors: names }, 'trend:backfill-selectors');
      rows = rows.concat(selectorRows(names, idsitehsr, weeks, base(cells)));
    }
  }
  return rows.filter((row) => row.segment === change.seg.id);
}

/**
 * The cells of every start group, one query per group, earliest first.
 * @param {Array<[string, string[]]>} groups
 * @param {(start: string, group: string[]) => Promise<object[]>} read
 */
async function groupedCells(groups, read) {
  const cells = [];
  for (const [start, group] of groups) for (const cell of await read(start, group)) cells.push(cell);
  return cells;
}

/**
 * @param {import('../ports/persistence/trend-store.js').TrendStore} persistence
 * @param {number} idsite
 * @param {import('../ports/persistence.js').AeTrendSelectorRow[]} seeds
 */
async function seedMissingSelectors(persistence, idsite, seeds) {
  const current = await persistence.readTrendSelectors(idsite);
  const have = new Set(current.map((row) => String(row.idsitehsr)));
  const missing = seeds.filter((row) => Number(row.idsite) === idsite && !have.has(String(row.idsitehsr)));
  if (missing.length > 0) await persistence.writeTrendSelectors(missing);
}

/**
 * @param {Function} segmented the run's per-group query
 * @param {object} params
 * @param {'template' | 'url'} kind
 * @param {string[]} paths
 * @param {string} label
 */
async function pathCellsOf(segmented, params, kind, paths, label) {
  if (paths.length === 0) return [];
  const match = pathMatchList(paths);
  const exactName = kind === 'url' ? 'urlExact' : 'templateExact';
  const extName = kind === 'url' ? 'urlExt' : 'templateExt';
  return segmented(
    (group, inputs) => pathAggregateSql(kind, group, inputs),
    { ...params, [exactName]: match.exact, [extName]: match.extensions },
    label,
    kind === 'url' ? 'urlPath' : 'path',
  );
}

function cellsOf(raw, field = 'path') {
  return raw.map((row) => ({
    week: String(row.week_start).slice(0, 10),
    viewport: String(row.viewport_value),
    segment: String(row.segment),
    segmentValue: String(row.segment_value),
    path: field === 'path' && row.path != null ? String(row.path) : '',
    urlPath: field === 'urlPath' && row.path != null ? String(row.path) : '',
    idsitehsr: row.idsitehsr == null ? '' : String(row.idsitehsr),
    selector: row.selector == null ? '' : String(row.selector),
    sessions: Number(row.sessions),
    buyers: Number(row.buyers),
    orders: Number(row.orders),
    revenue: Number(row.revenue),
    clicks: Number(row.clicks ?? 0),
    progressed: Number(row.progressed),
  }));
}

/**
 * @param {import('../ports/persistence.js').AeTrendRow[]} rows
 * @param {{paths: string[], urlPaths?: string[], pages: string[], selectorPlan: Array<{idsitehsr: number, selectors: string[]}>,
 *   segmentations: ReadonlyArray<{id: string}>}} expected
 */
export function verifyTrend(rows, expected) {
  /** @type {string[]} */
  const errors = [];
  const storedPaths = familyErrors(rows, expected.paths, 'path', 'step', errors);
  const storedUrlPaths = expected.urlPaths
    ? familyErrors(rows, expected.urlPaths, 'url_path', 'url_step', errors)
    : [];
  const storedPages = distinct(rows, (row) => row.rowKey === 'page', (row) => row.rowKey1);
  if (storedPages.length !== expected.pages.length) {
    errors.push(`pages stored ${storedPages.length}, expected ${expected.pages.length}`);
  }
  for (const page of expected.selectorPlan) {
    for (const selector of page.selectors) {
      const found = rows.some((row) => (
        row.rowKey === 'selector' && row.rowKey1 === selector && row.idsitehsr === page.idsitehsr
      ));
      if (!found) errors.push(`missing selector on ${page.idsitehsr}`);
    }
  }
  for (const [key, list] of [['path', expected.paths], ['url_path', expected.urlPaths ?? []]]) {
    if (list.length === 0) continue;
    const sample = rows.find((row) => row.rowKey === key && row.rowKey1 === list[0] && row.segment === 'all');
    if (sample) partitionErrors(rows, sample, expected.segmentations, errors);
  }
  if (errors.length > 0) {
    throw new Error(`trend check failed: ${errors.join('; ')}`);
  }
  return {
    ok: true,
    paths: storedPaths.length,
    urlPaths: storedUrlPaths.length,
    pages: storedPages.length,
    rows: rows.length,
  };
}

/**
 * @param {import('../ports/persistence.js').AeTrendRow[]} rows
 * @param {string[]} expected
 * @param {string} pathKey
 * @param {string} stepKey
 * @param {string[]} errors
 */
function familyErrors(rows, expected, pathKey, stepKey, errors) {
  const stored = distinct(rows, (row) => row.rowKey === pathKey, (row) => row.rowKey1);
  if (stored.length !== expected.length) {
    errors.push(`${pathKey} stored ${stored.length}, expected ${expected.length}`);
  }
  for (const path of expected) {
    if (!stored.includes(path)) errors.push(`missing ${pathKey} ${path}`);
    const firstWeek = rows.find((row) => row.rowKey === pathKey && row.rowKey1 === path)?.week;
    const steps = rows.filter((row) => (
      row.rowKey === stepKey
      && row.rowKey2 === path
      && row.viewportType === 'all'
      && row.segment === 'all'
      && row.segmentValue === 'all'
      && row.week === firstWeek
    ));
    const stepNames = new Set(steps.map((row) => row.rowKey1));
    if (stepNames.size !== path.split(' > ').length) {
      errors.push(`${pathKey} ${path} has ${stepNames.size} steps, expected ${path.split(' > ').length}`);
    }
  }
  return stored;
}

/**
 * The devices partition the sampled row's `all` total, and so do the
 * values of every segmentation.
 * @param {import('../ports/persistence.js').AeTrendRow[]} rows
 * @param {import('../ports/persistence.js').AeTrendRow} sample
 * @param {ReadonlyArray<{id: string}>} segmentations
 * @param {string[]} errors
 */
function partitionErrors(rows, sample, segmentations, errors) {
  const same = (row) => row.rowKey === sample.rowKey && row.rowKey1 === sample.rowKey1 && row.week === sample.week && row.segment === 'all' && row.segmentValue === 'all';
  const total = rows.find((row) => same(row) && row.viewportType === 'all');
  const devices = rows.filter((row) => same(row) && row.viewportType !== 'all');
  if (!total) {
    errors.push('missing viewport all row');
    return;
  }
  const deviceSessions = devices.reduce((sum, row) => sum + row.sessions, 0);
  if (deviceSessions !== total.sessions) {
    errors.push(`viewport sessions ${deviceSessions} do not add up to all ${total.sessions}`);
  }
  for (const seg of segmentations) {
    const parts = rows.filter((row) => (
      row.rowKey === sample.rowKey
      && row.rowKey1 === sample.rowKey1
      && row.week === sample.week
      && row.viewportType === 'all'
      && row.segment === seg.id
    ));
    const sessions = parts.reduce((sum, row) => sum + row.sessions, 0);
    if (sessions !== total.sessions) {
      errors.push(`${seg.id} sessions ${sessions} do not add up to all ${total.sessions}`);
    }
  }
}

/**
 * @param {import('../ports/persistence.js').AeTrendRow[]} rows
 * @param {(row: import('../ports/persistence.js').AeTrendRow) => boolean} keep
 * @param {(row: import('../ports/persistence.js').AeTrendRow) => string} value
 */
function distinct(rows, keep, value) {
  return [...new Set(rows.filter(keep).map(value))];
}
