import { checkPeriod, checkWindow } from './period.js';

/**
 * A dataset request: what an agent fills from a question or a transcript.
 *
 *   id             ^[a-z][a-z0-9_]*$; names the output folder
 *   question       the question in the requester's words
 *   idsite         one site
 *   window         { start, end }, days
 *   period         the time structure (period.js); default weeks starting Monday
 *   subject        sessions (default) builds; journeys, pages, and elements read ae_trend_row
 *   by             up to three attributes crossed into the row key
 *   segmentations  up to eight, each a registry id or a declaration; each is fanned out
 *                  into (segment, segment_value) rows beside segment = all, as the trend row is
 *   filter         a condition over attributes the query computes; only matching sessions count
 *   measures       what each row reports, in order
 *   derived        ratios the request declares: { id, label, data, ratio: [num, den], scale? }
 *   rank           { by, order: desc | asc, limit, other }: keep the top key combinations
 *                  over the window, and fold the rest into an (other) row unless other is false
 *   floor          { <additive measure>: minimum }: rows under it are kept and flagged below_floor
 *   sources        { <source>: { partial: refuse | allow } }: whether a source's missing days block the build
 *
 * @typedef {Object} DatasetRequest
 * @property {string} id
 * @property {string} question
 * @property {number} idsite
 * @property {{start: string, end: string}} window
 * @property {import('./period.js').PeriodSpec} period
 * @property {string} subject
 * @property {string[]} by
 * @property {Array<string | object>} segmentations
 * @property {object | null} filter
 * @property {string[]} measures
 * @property {object[]} derived
 * @property {{by: string, order: 'desc' | 'asc', limit: number, other: boolean} | null} rank
 * @property {Record<string, number>} floor
 * @property {Record<string, {partial: 'refuse' | 'allow'}>} sources
 * @property {object} [quality]  the request's data-quality block, { off?, rules?, add? }, checked when the screens resolve
 */

export const SUBJECTS = Object.freeze(['sessions', 'journeys', 'pages', 'elements']);
export const MAX_BY = 3;
export const MAX_SEGMENTATIONS = 8;
export const MAX_RANK = 1000;
export const MAX_WINDOW_DAYS = 400;

const ID = /^[a-z][a-z0-9_]*$/;
const KEYS = new Set(['id', 'question', 'idsite', 'window', 'period', 'subject', 'by', 'segmentations', 'filter', 'measures', 'derived', 'rank', 'floor', 'sources', 'quality']);

/**
 * Checks a request's shape. `problems` make it invalid: the requester fixes
 * them. `unknownGrain` and `unknownSubject` are valid asks the engine has no
 * vocabulary for, so they go to a person.
 * @param {unknown} doc
 * @returns {{request: DatasetRequest | null, problems: string[], unknownGrain: string | null, unknownSubject: string | null}}
 */
export function checkRequest(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { request: null, problems: ['a request is an object'], unknownGrain: null, unknownSubject: null };
  for (const key of Object.keys(doc)) if (!KEYS.has(key)) problems.push(`unknown key "${key}" (${[...KEYS].join(', ')})`);
  if (typeof doc.id !== 'string' || !ID.test(doc.id)) problems.push('id must match ^[a-z][a-z0-9_]*$');
  if (typeof doc.question !== 'string' || !doc.question.trim()) problems.push('question must be the question in words');
  if (!Number.isInteger(doc.idsite) || doc.idsite <= 0) problems.push('idsite must be a positive integer');
  problems.push(...checkWindow(doc.window));
  const period = checkPeriod(doc.period);
  problems.push(...period.problems);

  const subject = doc.subject ?? 'sessions';
  let unknownSubject = null;
  if (typeof subject !== 'string') problems.push('subject must be a string');
  else if (!SUBJECTS.includes(subject)) unknownSubject = subject;

  const list = (name, max, item) => {
    const value = doc[name] ?? [];
    if (!Array.isArray(value)) {
      problems.push(`${name} must be a list`);
      return [];
    }
    if (value.length > max) problems.push(`${name} has ${value.length} entries; at most ${max}`);
    for (const [i, entry] of value.entries()) {
      const problem = item(entry);
      if (problem) problems.push(`${name}[${i}] ${problem}`);
    }
    return value;
  };
  const text = (entry) => (typeof entry === 'string' && entry ? null : 'must be a name');
  const by = list('by', MAX_BY, text);
  if (new Set(by).size !== by.length) problems.push('by names an attribute twice');
  const segmentations = list('segmentations', MAX_SEGMENTATIONS, (entry) => (
    typeof entry === 'string' || (entry && typeof entry === 'object' && !Array.isArray(entry)) ? null : 'must be a segmentation id or a declaration'));
  const measures = list('measures', 40, text);
  if (measures.length === 0) problems.push('measures must name at least one measure');
  if (new Set(measures).size !== measures.length) problems.push('measures names a measure twice');
  const derived = list('derived', 20, (entry) => (entry && typeof entry === 'object' && !Array.isArray(entry) ? null : 'must be an object'));

  const filter = doc.filter ?? null;
  if (filter !== null && (typeof filter !== 'object' || Array.isArray(filter))) problems.push('filter must be a condition');

  let rank = null;
  if (doc.rank !== undefined) {
    const r = doc.rank;
    if (!r || typeof r !== 'object' || Array.isArray(r)) problems.push('rank must be { by, order?, limit, other? }');
    else {
      for (const key of Object.keys(r)) if (!['by', 'order', 'limit', 'other'].includes(key)) problems.push(`rank has unknown key "${key}"`);
      if (typeof r.by !== 'string' || !r.by) problems.push('rank.by must name a measure');
      if (r.order !== undefined && r.order !== 'desc' && r.order !== 'asc') problems.push('rank.order is desc or asc');
      if (!Number.isInteger(r.limit) || r.limit < 1 || r.limit > MAX_RANK) problems.push(`rank.limit is a whole number from 1 to ${MAX_RANK}`);
      if (r.other !== undefined && typeof r.other !== 'boolean') problems.push('rank.other is true or false');
      if (by.length === 0) problems.push('rank needs a by key to rank');
      rank = { by: r.by, order: r.order ?? 'desc', limit: r.limit, other: r.other ?? true };
    }
  }

  const floor = doc.floor ?? {};
  if (!floor || typeof floor !== 'object' || Array.isArray(floor)) problems.push('floor must map measures to minimums');
  else for (const [name, min] of Object.entries(floor)) if (typeof min !== 'number' || !Number.isFinite(min) || min < 0) problems.push(`floor.${name} must be a number at least 0`);

  const sources = doc.sources ?? {};
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) problems.push('sources must map source ids to options');
  else {
    for (const [name, options] of Object.entries(sources)) {
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => key !== 'partial')
        || !['refuse', 'allow'].includes(options.partial ?? 'refuse')) {
        problems.push(`sources.${name} is { partial: refuse | allow }`);
      }
    }
  }

  const quality = doc.quality ?? null;
  if (quality !== null && (typeof quality !== 'object' || Array.isArray(quality))) problems.push('quality must be { off?, rules?, add? }');

  if (problems.length > 0 || !period.spec) return { request: null, problems, unknownGrain: period.unknownGrain, unknownSubject };
  return {
    request: {
      id: doc.id,
      question: doc.question.trim(),
      idsite: doc.idsite,
      window: { start: doc.window.start, end: doc.window.end },
      period: period.spec,
      subject,
      by: [...by],
      segmentations: [...segmentations],
      filter,
      measures: [...measures],
      derived: [...derived],
      rank,
      floor: { ...floor },
      sources: Object.fromEntries(Object.entries(sources).map(([name, options]) => [name, { partial: options.partial ?? 'refuse' }])),
      ...(quality ? { quality: JSON.parse(JSON.stringify(quality)) } : {}),
    },
    problems: [],
    unknownGrain: period.unknownGrain,
    unknownSubject,
  };
}
