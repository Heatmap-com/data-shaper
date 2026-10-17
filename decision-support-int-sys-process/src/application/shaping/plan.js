import { CHANNEL_TABLES } from '../../domain/channel-rules/rules.js';
import { LISTS, checkCondition, checkDeclaration, fieldsOf, resolveLists } from '../../domain/segmentation/index.js';
import { conditionFields } from '../../domain/shaping/attributes.js';
import { addDays, dayDiff } from '../../domain/shaping/dates.js';
import { SESSION_MEASURES, SHIPPED_DERIVED, resolveMeasures } from '../../domain/shaping/measures.js';
import { periodsIn, queryWindow } from '../../domain/shaping/period.js';
import { MAX_WINDOW_DAYS, checkRequest } from '../../domain/shaping/request.js';
import { planGroups } from '../../enrichment/segmentation-sql.js';
import { declaredSegmentation } from '../segmentation/registry.js';

/**
 * The answer to one dataset request. `status` is what the engine can do:
 *
 *   invalid       the request is malformed; `reasons` say what to fix
 *   needs_person  it asks for something the engine has no vocabulary for;
 *                 `needs` names each one, the level of the change, and where it goes
 *   blocked       the vocabulary is there and the data is not: a missing
 *                 connection, missing days, a warehouse column, a split a source cannot make
 *   read          the rows are already stored; `read` is the query that returns them
 *   ready         it can be built; `plan` is what the build runs
 *
 * and, after a build, `built` or `failed` (a check did not pass).
 *
 * @typedef {'invalid' | 'needs_person' | 'blocked' | 'read' | 'ready' | 'built' | 'failed'} AnswerStatus
 * @typedef {{name: string, level: 'declare' | 'extend' | 'new_grain', change: string}} Need
 * @typedef {Object} Answer
 * @property {string} id
 * @property {string} question
 * @property {number | null} idsite
 * @property {AnswerStatus} status
 * @property {'read' | 'declare' | null} level   the lowest level that answers it, when it can be answered
 * @property {string[]} reasons
 * @property {Need[]} needs
 * @property {string[]} notes                     caveats a reader of the data must know
 * @property {{table: string, sql: string}} [read]
 * @property {ShapePlan} [plan]
 *
 * @typedef {Object} ShapePlan
 * @property {string} id
 * @property {number} idsite
 * @property {string | null} slug
 * @property {import('../../domain/shaping/request.js').DatasetRequest} request
 * @property {{start: string, end: string}} window
 * @property {{start: string, end: string}} queryWindow
 * @property {import('../../domain/shaping/period.js').PeriodSpec} period
 * @property {Array<{start: string, end: string, complete: boolean}>} periods
 * @property {string[]} by
 * @property {import('../../domain/shaping/attributes.js').Attribute[]} byAttributes
 * @property {string[]} queryKeys
 * @property {import('../../domain/shaping/attributes.js').Attribute[]} attributes every attribute the query computes
 * @property {object | null} filter with lists resolved
 * @property {import('../../ports/segmentation.js').Segmentation[]} segmentations
 * @property {import('../../enrichment/segmentation-sql.js').QueryGroup[]} groups
 * @property {import('../../domain/shaping/measures.js').Measure[]} measures
 * @property {string[]} output the measures each row reports, in order
 * @property {string[]} sources the fact kinds the build reads
 * @property {string[]} lookupSources the lookup kinds the build reads
 */

/**
 * Plans one request. Nothing here queries the warehouse except the column
 * list of udp_hsrce_visits, read only when a visit attribute is wanted,
 * and the stored trend weeks, read only for a journeys, pages, or elements
 * request.
 *
 * @param {unknown} doc
 * @param {object} deps
 * @param {{forSite: (idsite: number) => ReadonlyMap<string, import('../../ports/segmentation.js').Segmentation>, defaults: (idsite: number, grain: string) => string[]}} deps.segmentations
 * @param {ReturnType<typeof import('./registry.js').createShapingRegistry>} deps.shaping
 * @param {() => Promise<Set<string>>} deps.visitColumns
 * @param {(idsite: number) => Promise<import('../../ports/persistence/trend-store.js').TrendSegmentRange>} deps.trendRange the stored weeks of each trend subject on segment all
 * @param {string} deps.today
 * @param {string} deps.database where ae_trend_row lives, for a read
 * @returns {Promise<Answer>}
 */
export async function planRequest(doc, deps) {
  const head = {
    id: typeof doc?.id === 'string' && doc.id ? doc.id : '(no id)',
    question: typeof doc?.question === 'string' ? doc.question.trim() : '',
    idsite: Number.isInteger(doc?.idsite) ? doc.idsite : null,
  };
  const answer = (status, level, extra = {}) => ({ ...head, status, level, reasons: [], needs: [], notes: [], ...extra });

  const checked = checkRequest(doc);
  if (checked.problems.length > 0) return answer('invalid', null, { reasons: checked.problems });
  /** @type {Need[]} */
  const early = [];
  if (checked.unknownGrain) {
    early.push({
      name: `period.grain ${checked.unknownGrain}`,
      level: 'extend',
      change: `"${checked.unknownGrain}" is not one of day, week, month, quarter, window. A new grain is periodSql, periodOf, periodEnd, and previousStart in src/domain/shaping/period.js, with a test that the SQL and JavaScript agree. A cohort grain, which anchors a visitor on a first visit, also needs visitor history before the window, as return_intent reads it.`,
    });
  }
  if (checked.unknownSubject) {
    early.push({
      name: `subject ${checked.unknownSubject}`,
      level: 'new_grain',
      change: `Shaped datasets build sessions; journeys, pages, and elements read ae_trend_row. A ${checked.unknownSubject} subject needs its own grain, reviewed by a person.`,
    });
  }
  if (early.length > 0) return answer('needs_person', null, { needs: early });
  const request = /** @type {import('../../domain/shaping/request.js').DatasetRequest} */ (checked.request);
  if (request.subject !== 'sessions') return planRead(request, deps, answer);
  return planSessions(request, deps, answer);
}

/** @param {import('../../domain/shaping/request.js').DatasetRequest} request */
async function planSessions(request, deps, answer) {
  const problems = [];
  const reasons = [];
  /** @type {Need[]} */
  const needs = [];
  const notes = [];
  const site = deps.shaping.forSite(request.idsite);
  const slug = site.slug ?? '<slug>';
  const attrs = site.attributes;
  const needAttribute = (name, where) => needs.push({
    name: `attribute ${name}`,
    level: 'declare',
    change: `No attribute "${name}" (${where}). If a udp_hsrce_visits column holds it, declare a visit attribute in orchestration/sites/${slug}/attributes.json. If it comes from outside the warehouse, it is a column of a lookup source kind in src/catalog/sources/, which is an Extend.`,
  });

  if (request.window.end >= deps.today) reasons.push(`the window ends ${request.window.end}; the last whole day is ${addDays(deps.today, -1)}`);
  const qw = queryWindow(request.period, request.window);
  const days = dayDiff(qw.end, qw.start) + 1;
  if (days > MAX_WINDOW_DAYS) reasons.push(`the query reads ${days} days (${qw.start} to ${qw.end}); one request reads at most ${MAX_WINDOW_DAYS}. Split the window into requests`);
  const periods = periodsIn(request.period, request.window);
  const cut = periods.filter((p) => !p.complete).map((p) => p.start);
  if (request.period.compare && cut.length > 0) {
    problems.push(`period.compare reads whole periods, and the window cuts ${cut.join(' and ')}; start and end the window on period bounds, or set period.partial to drop`);
  }

  const by = [];
  for (const id of request.by) {
    const attr = attrs.get(id);
    if (attr) by.push(attr);
    else needAttribute(id, 'by');
  }

  const vocabulary = { fields: conditionFields(attrs.values()), lists: LISTS, bases: CHANNEL_TABLES };
  const lookupIds = new Set([...attrs.values()].filter((attr) => !attr.inQuery).map((attr) => attr.id));
  /** 'unknown' when a field is not an attribute (a need is recorded), a problem text for a lookup, else null. */
  const conditionTrouble = (condition, owner) => {
    let names;
    try {
      names = fieldsOf(condition);
    } catch {
      return null;
    }
    const lookups = names.filter((name) => lookupIds.has(name));
    if (lookups.length > 0) return `${owner} reads ${lookups.join(', ')}: a lookup attribute keys rows after the query, so no condition can read it`;
    const unknown = names.filter((name) => typeof name === 'string' && !attrs.has(name));
    for (const name of unknown) needAttribute(name, owner);
    return unknown.length > 0 ? 'unknown' : null;
  };

  const registered = deps.segmentations.forSite(request.idsite);
  const segmentations = [];
  for (const [i, entry] of request.segmentations.entries()) {
    if (typeof entry === 'string') {
      const seg = registered.get(entry);
      if (!seg) {
        needs.push({ name: `segmentation ${entry}`, level: 'declare', change: `No segmentation "${entry}" for idsite ${request.idsite}. Declare it in the request's segmentations list, or in orchestration/sites/${slug}/segmentations.json so every grain reads it.` });
      } else if (seg.kind !== 'declared') {
        needs.push({ name: `segmentation ${entry}`, level: 'extend', change: `${entry} is computed: its SQL reads history before the window. A shaped dataset fans out declared segmentations; reading ${entry} needs its CTEs and parameters in src/enrichment/shape-sql.js.` });
      } else {
        segmentations.push(seg);
      }
      continue;
    }
    const owner = `segmentations[${i}]${typeof entry.id === 'string' ? ` (${entry.id})` : ''}`;
    let trouble = null;
    for (const rule of [...(Array.isArray(entry.rules) ? entry.rules : []), ...(Array.isArray(entry.prepend) ? entry.prepend : []), ...(Array.isArray(entry.append) ? entry.append : [])]) {
      if (rule && typeof rule === 'object' && rule.when) trouble ??= conditionTrouble(rule.when, owner);
    }
    if (trouble === 'unknown') continue;
    if (trouble) {
      problems.push(trouble);
      continue;
    }
    if (typeof entry.id === 'string' && registered.has(entry.id)) {
      problems.push(`${owner}: segmentation ${entry.id} is already defined for idsite ${request.idsite}; name the request's declaration otherwise, or select ${entry.id} by id`);
      continue;
    }
    try {
      segmentations.push(declaredSegmentation(checkDeclaration(entry, vocabulary, `request ${request.id}`)));
    } catch (err) {
      problems.push(message(err));
    }
  }
  const ids = segmentations.map((seg) => seg.id);
  if (new Set(ids).size !== ids.length) problems.push('segmentations selects one segmentation twice');

  let filter = null;
  if (request.filter) {
    const trouble = conditionTrouble(request.filter, 'filter');
    if (trouble === null) {
      try {
        checkCondition(request.filter, vocabulary, 'filter');
        filter = resolveLists(request.filter, LISTS);
      } catch (err) {
        problems.push(message(err));
      }
    } else if (trouble !== 'unknown') {
      problems.push(trouble);
    }
  }

  const measures = resolveMeasures({ measures: request.measures, derived: request.derived, rankBy: request.rank?.by ?? null, floor: request.floor }, deps.shaping.kinds);
  problems.push(...measures.problems);
  for (const missing of measures.unknown) {
    needs.push({
      name: `measure ${missing.name}`,
      level: 'extend',
      change: missing.name.includes('.')
        ? `${missing.why}. A new measure of a source is a column of its kind in src/catalog/sources/; a new source is a kind and an adapter in src/adapters/external-sources/.`
        : `${missing.why}. A ratio of measures that exist is declared in the request's derived list; a new session measure is an aggregate in SESSION_MEASURES (src/domain/shaping/measures.js) and the shaped query.`,
    });
  }
  if (request.rank) {
    const ranked = measures.measures.find((m) => m.id === request.rank.by);
    if (ranked && !measures.output.includes(ranked.id)) notes.push(`rows are ranked by ${ranked.id}, which is not one of the columns`);
  }

  if (problems.length > 0) return answer('invalid', null, { reasons: problems, needs });
  if (needs.length > 0) return answer('needs_person', null, { needs, reasons });

  const lookupSources = [...new Set(by.filter((attr) => attr.kind === 'lookup').map((attr) => attr.lookup.source))];
  for (const source of [...new Set([...measures.sources, ...lookupSources])]) {
    if (!site.connections.has(source)) reasons.push(`idsite ${request.idsite} has no ${source} connection; add one to orchestration/sites/${slug}/sources.json`);
  }
  for (const source of measures.sources) {
    const kind = deps.shaping.kinds.get(source);
    const keyed = kind.keys.map((mapping) => mapping.attribute);
    for (const attr of by) {
      if (keyed.includes(attr.id) || (attr.kind === 'lookup' && keyed.includes(attr.lookup.key))) continue;
      reasons.push(`${source} measures cannot be split by ${attr.id}: ${source} rows are keyed by day${keyed.length ? ` and ${keyed.join(', ')}` : ''}. Drop ${attr.id} from by, or read it as a segmentation, where ${source} measures sit on segment all only`);
    }
    if (filter) {
      const outside = fieldsOf(filter).filter((field) => !keyed.includes(field));
      if (outside.length > 0) reasons.push(`${source} measures cannot be filtered on ${outside.join(', ')}: ${source} rows carry no such value, so the spend of the filtered sessions is unknown`);
    }
  }

  const queryKeys = [...new Set(by.map((attr) => (attr.kind === 'lookup' ? attr.lookup.key : attr.id)))];
  const wanted = [...new Set([...queryKeys, ...(filter ? fieldsOf(filter) : []), ...segmentations.flatMap((seg) => seg.fields)])];
  const attributes = wanted.map((id) => attrs.get(id));
  const visit = attributes.filter((attr) => attr.kind === 'visit');
  if (visit.length > 0) {
    const columns = await deps.visitColumns();
    for (const attr of visit) if (!columns.has(attr.column)) reasons.push(`udp_hsrce_visits has no column ${attr.column} on this warehouse, so ${attr.id} cannot be read`);
  }
  if (reasons.length > 0) return answer('blocked', null, { reasons });

  if (periods.length === 0) return answer('blocked', null, { reasons: ['the window holds no whole period, and period.partial is drop'] });
  if (periods.some((p) => !p.complete)) notes.push(`the window cuts ${periods.filter((p) => !p.complete).map((p) => p.start).join(' and ')}; those rows have period_complete 0 and cover only the window's days`);
  if (request.period.grain === 'day') notes.push('a visit that crosses midnight is a session on each day it has rows');
  if (measures.sources.length > 0 && segmentations.length > 0) notes.push(`${measures.sources.join(', ')} measures sit on segment all only; a source cannot split by a segmentation of sessions`);
  if (wanted.includes('returning') || segmentations.some((seg) => seg.fields.includes('returning'))) notes.push('returning reads the tracker\'s flag on a browser id (config_id), not a person; a visitor on a second browser or device is new');
  if (measures.sources.includes('meta_ads')) notes.push('meta_ads purchases and purchase_value are Meta\'s attribution; orders and revenue are what the tracker matched to sessions. Compare the two as shares, not as one number');

  return answer('ready', 'declare', {
    notes,
    plan: {
      id: request.id,
      idsite: request.idsite,
      slug: site.slug,
      request,
      window: request.window,
      queryWindow: qw,
      period: request.period,
      periods,
      by: by.map((attr) => attr.id),
      byAttributes: by,
      queryKeys,
      attributes,
      filter,
      segmentations,
      groups: planGroups(segmentations),
      measures: measures.measures,
      output: measures.output,
      sources: measures.sources,
      lookupSources,
    },
  });
}

const TREND_ROW_TYPES = Object.freeze({ journeys: 'journey', pages: 'page', elements: 'element' });
const TREND_ROW_KEYS = Object.freeze({ journeys: ['path', 'url_path'], pages: ['page'], elements: ['selector'] });
const TREND_MEASURES = new Set([...Object.keys(SESSION_MEASURES), 'clicks', ...Object.keys(SHIPPED_DERIVED)]);

/**
 * A journeys, pages, or elements request reads ae_trend_row when the
 * stored rows hold it: whole Monday weeks, the site's trend segmentations,
 * device or nothing as the key, and the trend's measures. Anything else is
 * a grain the trend row does not hold.
 * @param {import('../../domain/shaping/request.js').DatasetRequest} request
 */
async function planRead(request, deps, answer) {
  const why = [];
  const p = request.period;
  if (p.grain !== 'week' || p.weekStart !== 'monday' || p.rolling) why.push('the trend row holds Monday weeks');
  if (request.by.some((id) => id !== 'device')) why.push('the trend row keys a subject by device only');
  if (request.filter) why.push('the trend row has no filter beyond its segmentations');
  const stored = deps.segmentations.defaults(request.idsite, 'trend');
  const extra = request.segmentations.filter((entry) => typeof entry !== 'string' || !stored.includes(entry));
  if (extra.length > 0) why.push(`the site's trend stores ${stored.join(', ')}, not ${extra.map((entry) => (typeof entry === 'string' ? entry : entry.id ?? 'an inline declaration')).join(', ')}`);
  const other = request.measures.filter((name) => !TREND_MEASURES.has(name));
  if (other.length > 0) why.push(`the trend row carries ${[...TREND_MEASURES].join(', ')}, not ${other.join(', ')}`);
  if (why.length > 0) {
    return answer('needs_person', null, {
      needs: [{
        name: `${request.subject} shaped by ${[p.grain, ...request.by].join(', ')}`,
        level: 'new_grain',
        change: `${why.join('; ')}. Reading ${request.subject} this way means a new grain of trend rows, or an Extend of the trend job, reviewed by a person. A sessions request answers most of it from the same data.`,
      }],
    });
  }
  const weeks = periodsIn({ ...p, partial: 'drop' }, request.window);
  if (weeks.length === 0) return answer('blocked', null, { reasons: ['the window holds no whole Monday week, and trend rows are whole weeks'] });
  const first = weeks[0].start;
  const last = weeks[weeks.length - 1].start;
  const end = weeks[weeks.length - 1].end;
  let subjects;
  try {
    subjects = (await deps.trendRange(request.idsite)).subjects.filter((s) => TREND_ROW_KEYS[request.subject].includes(s.rowKey));
  } catch (err) {
    return answer('blocked', null, { reasons: [`the stored trend rows cannot be read: ${message(err)}`] });
  }
  const held = subjects.filter((s) => s.first <= last && s.last >= first);
  const run = `node src/cli.js --trend --sites ${request.idsite} --window-start ${first} --window-end ${end}`;
  if (held.length === 0) {
    const span = subjects.length > 0 ? `; its ${request.subject} rows run ${minOf(subjects.map((s) => s.first))} through ${maxOf(subjects.map((s) => s.last))}` : '';
    return answer('blocked', null, {
      reasons: [`ae_trend_row holds no ${TREND_ROW_TYPES[request.subject]} rows for idsite ${request.idsite} in the weeks ${first} through ${end}${span}. The trend job stores them, and writes ae_trend_row: ${run}`],
    });
  }
  const segments = ['all', ...request.segmentations];
  const table = `${deps.database}.ae_trend_row_current`;
  const sql = [
    'SELECT week, row_key, row_key_1, row_key_2, idsitehsr, viewport_type, segment, segment_value,',
    '       sessions, buyers, orders, revenue, clicks, progressed, metrics',
    `FROM ${table}`,
    `WHERE idsite = ${request.idsite}`,
    `  AND row_type = '${TREND_ROW_TYPES[request.subject]}'`,
    `  AND week BETWEEN '${weeks[0].start}' AND '${weeks[weeks.length - 1].start}'`,
    `  AND segment IN (${segments.map((id) => `'${id}'`).join(', ')})`,
    request.by.includes('device') ? "  AND viewport_type != 'all'" : "  AND viewport_type = 'all'",
    'ORDER BY week, row_key, row_key_1, row_key_2, segment, segment_value',
  ].join('\n');
  const notes = [`the stored weeks are ${first} through ${end}`];
  if (first !== request.window.start || end !== request.window.end) notes.push('the window is trimmed to whole Monday weeks, the only weeks the trend row stores');
  const from = minOf(held.map((s) => s.first));
  const to = maxOf(held.map((s) => s.last));
  if (from > first || to < last) notes.push(`the stored rows cover the weeks of ${from} through ${to}; the other weeks read no rows until the trend job runs over them: ${run}`);
  if (request.subject === 'journeys') notes.push(`a journey row is one whole-session page sequence among the ${held.length} the trend chose by revenue, not every journey and not a step-by-step flow from the entry page`);
  if (p.compare) notes.push('compare each week with the stored week before it; the rows carry no previous-week column');
  return answer('read', 'read', { notes, read: { table, sql } });
}

const message = (err) => (err instanceof Error ? err.message : String(err));
const minOf = (dates) => dates.reduce((a, b) => (b < a ? b : a));
const maxOf = (dates) => dates.reduce((a, b) => (b > a ? b : a));
