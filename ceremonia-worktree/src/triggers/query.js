import { getTrigger, listTriggers } from './definitions.js';
import { addDays, dayDiff, mondayOf } from './time.js';

export { getTrigger, listTriggers };

const DIMENSIONS = [
  'device',
  'channel',
  'source',
  'medium',
  'returning',
  'country',
  'landingPage',
  'entryTemplate',
];

const FILTERS = [...DIMENSIONS, 'idvisit'];

const SEGMENTATION = 'segmentation:';

/** The registered segmentation fields an assembled session fills (see assembleSessions). */
export const TRIGGER_FIELDS = Object.freeze([
  'referer_type', 'referer_name', 'utm_source', 'source_or_referrer', 'utm_medium', 'utm_campaign', 'returning', 'country', 'has_order',
]);

/**
 * One read path for a trigger's week-over-week trend.
 *
 * Weeks start Monday. A week that the requested range only partly covers
 * is compared with the same weekdays of the previous week, not with that
 * whole week. Pass the previous week's sessions and hits when the first
 * week in range needs a delta; days that were not passed in count as zero,
 * and a percent delta whose baseline is zero is null.
 *
 * Hit rate is hits ÷ sessions in the segment. RPS is chain revenue ÷
 * those sessions. `granularity` other than `week` is rejected.
 *
 * The input accepts `site_id` as an alias of `idsite`. Stored rows use
 * `idsite`. A filter or segment on a field that is not one of the stored
 * dimensions is rejected: join it from the visit on `idvisit` instead.
 *
 * A `segment_by` entry `segmentation:<id>` groups by a declared
 * segmentation from `segmentations`, the site's registry map. Each session
 * is classified on its `fields`, and each hit takes its session's value; a
 * hit whose session was not passed in has the value ''.
 *
 * @param {object} input
 */
export function queryTriggerTrends(input) {
  const idsite = input.site_id ?? input.idsite;
  if (!idsite) throw new Error('site_id is required');
  if (!input.trigger_key) throw new Error('trigger_key is required');
  if (input.granularity && input.granularity !== 'week') {
    throw new Error(`granularity "${input.granularity}" is not supported; weeks are Monday-start`);
  }
  const start = input.date_range?.start;
  const end = input.date_range?.end;
  if (!start || !end) throw new Error('date_range.start and date_range.end are required');
  const segmentBy = input.segment_by ?? [];
  const classifiers = segmentBy
    .filter((dimension) => dimension.startsWith(SEGMENTATION))
    .map((dimension) => ({ dimension, classify: classifierOf(dimension.slice(SEGMENTATION.length), input.segmentations) }));
  for (const dimension of segmentBy) if (!dimension.startsWith(SEGMENTATION)) assertDimension(dimension, DIMENSIONS);
  const filters = input.filters ?? {};
  for (const dimension of Object.keys(filters)) assertDimension(dimension, FILTERS);

  const hits = (input.hits ?? []).filter((hit) => (
    String(hit.idsite ?? idsite) === String(idsite) && hit.triggerKey === input.trigger_key
  ));
  const chains = input.chains ?? [];
  const chainByHit = new Map(chains.map((chain) => [hitKey(chain), chain]));
  let sessions = (input.sessions ?? []).filter((session) => matches(session, filters));
  let rangedHits = hits.filter((hit) => matches(hit, filters));
  if (classifiers.length > 0) {
    /** @type {Map<string, Record<string, string>>} */
    const values = new Map();
    for (const session of input.sessions ?? []) {
      values.set(String(session.idvisit), Object.fromEntries(classifiers.map(({ dimension, classify }) => [dimension, classify(session.fields ?? {})])));
    }
    const unknown = Object.fromEntries(classifiers.map(({ dimension }) => [dimension, '']));
    sessions = sessions.map((session) => ({ ...session, ...values.get(String(session.idvisit)) }));
    rangedHits = rangedHits.map((hit) => ({ ...hit, ...(values.get(String(hit.idvisit)) ?? unknown) }));
  }

  /** @type {Map<string, string[]>} */
  const weeks = new Map();
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const week = mondayOf(day);
    const days = weeks.get(week) ?? [];
    days.push(day);
    weeks.set(week, days);
  }

  /** @type {Map<string, object>} */
  const rows = new Map();
  for (const [week, days] of weeks) {
    const groups = groupBy(segmentBy, sessions, rangedHits, days, chainByHit);
    for (const [segmentKey, group] of groups) {
      rows.set(`${week}|${segmentKey}`, metricsRow(week, days, group, input.trigger_key));
    }
    if (groups.size === 0) {
      rows.set(`${week}|`, metricsRow(week, days, emptyGroup(segmentBy), input.trigger_key));
    }
  }

  for (const row of rows.values()) {
    const baselineDays = row.alignedDates.map((day) => addDays(day, -7));
    const baseline = measure(
      segmentBy,
      sessions,
      rangedHits,
      baselineDays,
      chainByHit,
      row.segment,
    );
    row.wow = deltas(row, baseline);
  }
  return [...rows.values()].sort((a, b) => a.week.localeCompare(b.week) || a.segmentKey.localeCompare(b.segmentKey));
}

/**
 * @param {string} dimension
 * @param {string[]} allowed
 */
function assertDimension(dimension, allowed) {
  if (!allowed.includes(dimension)) {
    throw new Error(
      `"${dimension}" is not a stored trigger dimension; join it from the visit on idvisit`,
    );
  }
}

/**
 * A declared segmentation's classifier, refused when it cannot read a
 * trigger session.
 * @param {string} id
 * @param {ReadonlyMap<string, import('../ports/segmentation.js').Segmentation> | undefined} segmentations
 */
function classifierOf(id, segmentations) {
  if (!segmentations) throw new Error(`segment_by ${SEGMENTATION}${id} needs the site's segmentations`);
  const seg = segmentations.get(id);
  if (!seg) throw new Error(`unknown segmentation "${id}" (${[...segmentations.keys()].sort().join(', ')})`);
  if (!seg.classify) throw new Error(`segmentation ${id} is computed: it has no JavaScript twin, so it cannot segment trigger trends`);
  const missing = seg.fields.filter((field) => !TRIGGER_FIELDS.includes(field));
  if (missing.length > 0) throw new Error(`segmentation ${id} reads ${missing.join(', ')}, which trigger sessions do not carry`);
  return seg.classify;
}

/** @param {object} row @param {object} filters */
function matches(row, filters) {
  return Object.entries(filters).every(([key, value]) => row[key] === value);
}

/** @param {object} row */
function hitKey(row) {
  return [row.idsite, row.triggerKey, row.serverDate, row.idvisit, row.configId].join('|');
}

/**
 * @param {string[]} segmentBy
 * @param {object[]} sessions
 * @param {object[]} hits
 * @param {string[]} days
 * @param {Map<string, object>} chainByHit
 */
function groupBy(segmentBy, sessions, hits, days, chainByHit) {
  /** @type {Map<string, { segment: object, sessions: Set<string>, hits: object[], chains: object[], versions: Set<number> }>} */
  const groups = new Map();
  const daySet = new Set(days);
  const ensure = (segment) => {
    const key = segmentBy.map((dimension) => `${dimension}=${segment[dimension] ?? ''}`).join('|');
    let group = groups.get(key);
    if (!group) {
      group = { segment, sessions: new Set(), hits: [], chains: [], versions: new Set() };
      groups.set(key, group);
    }
    return group;
  };
  for (const session of sessions) {
    if (!daySet.has(session.serverDate)) continue;
    ensure(segmentOf(session, segmentBy)).sessions.add(String(session.idvisit));
  }
  for (const hit of hits) {
    if (!daySet.has(hit.serverDate)) continue;
    const group = ensure(segmentOf(hit, segmentBy));
    group.hits.push(hit);
    group.versions.add(hit.triggerVersion);
    const chain = chainByHit.get(hitKey(hit));
    if (chain) group.chains.push(chain);
  }
  return groups;
}

/** @param {object} row @param {string[]} segmentBy */
function segmentOf(row, segmentBy) {
  /** @type {object} */
  const segment = {};
  for (const dimension of segmentBy) segment[dimension] = row[dimension] ?? '';
  return segment;
}

/** @param {string[]} segmentBy */
function emptyGroup(segmentBy) {
  return { segment: segmentOf({}, segmentBy), sessions: new Set(), hits: [], chains: [], versions: new Set() };
}

/**
 * @param {string} week
 * @param {string[]} days
 * @param {object} group
 * @param {string} triggerKey
 */
function metricsRow(week, days, group, triggerKey) {
  const measured = measureGroup(group);
  const versions = [...group.versions].sort((a, b) => a - b);
  return {
    triggerKey,
    week,
    alignedDates: days,
    partial: days.length < 7,
    segment: group.segment,
    segmentKey: Object.entries(group.segment).map(([key, value]) => `${key}=${value}`).join('|'),
    triggerVersions: versions,
    versionChanged: versions.length > 1,
    ...measured,
  };
}

/**
 * Baseline for one segment, using the caller's full session and hit lists
 * so days just outside the requested range still count when they were passed in.
 */
function measure(segmentBy, sessions, hits, days, chainByHit, segment) {
  const groups = groupBy(segmentBy, sessions, hits, days, chainByHit);
  const key = segmentBy.map((dimension) => `${dimension}=${segment[dimension] ?? ''}`).join('|');
  const group = groups.get(key) ?? emptyGroup(segmentBy);
  return { ...measureGroup(group), triggerVersions: [...group.versions] };
}

/** @param {object} group */
function measureGroup(group) {
  const hits = group.hits.length;
  const sessions = group.sessions.size;
  const purchased = group.chains.filter((chain) => chain.purchased).length;
  const recovered = group.chains.filter((chain) => chain.recovered).length;
  const revenue = group.chains.reduce((sum, chain) => sum + (Number(chain.revenue) || 0), 0);
  return {
    hits,
    sessions,
    hitRate: sessions > 0 ? hits / sessions : null,
    purchased,
    conversionRate: hits > 0 ? purchased / hits : null,
    recovered,
    recoveryRate: hits > 0 ? recovered / hits : null,
    revenue,
    rps: sessions > 0 ? revenue / sessions : null,
  };
}

const DELTA_FIELDS = ['hits', 'hitRate', 'conversionRate', 'recoveryRate', 'revenue', 'rps'];

/** @param {object} current @param {object} prior */
function deltas(current, prior) {
  /** @type {object} */
  const wow = {};
  for (const field of DELTA_FIELDS) {
    const left = current[field];
    const right = prior[field];
    if (left == null || right == null) {
      wow[field] = { abs: null, pct: null };
      continue;
    }
    const abs = left - right;
    wow[field] = { abs, pct: right === 0 ? null : abs / right };
  }
  const priorVersions = new Set(prior.triggerVersions ?? []);
  const changed = current.triggerVersions.some((version) => !priorVersions.has(version));
  current.versionChanged = current.versionChanged || (priorVersions.size > 0 && changed);
  return wow;
}

export { dayDiff };
