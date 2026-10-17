import { DEFAULT_TRIGGERS, resolveDefinitions } from './definitions.js';
import { chainOutcome, qualifies } from './evaluate.js';
import { atStride, PROGRESS_STRIDE, progressEvery } from './progress.js';
import { addDays, dayDiff, eachDate } from './time.js';

/**
 * One day's trigger batch. Hits are the sessions or visitors that qualify
 * on `asOf`. Chains cover every hit whose window is still open on `asOf`,
 * including hits from earlier days in that window, so a rerun of the same
 * day with the same sessions produces the same rows. A chain stays
 * `final: false` until `asOf` reaches the day the window closes.
 *
 * @param {object} args
 * @param {string} args.asOf YYYY-MM-DD
 * @param {number} args.idsite
 * @param {object[]} args.sessions visit facts. See evaluate.js.
 * @param {Record<string, object>} [args.overrides] per-trigger predicate patches for this site
 * @param {object[]} [args.recorded] definitions stored by the previous run
 * @param {boolean} [args.withChains] when false, skip chain outcomes. Hits are unchanged.
 * @param {(fields: object, force?: boolean) => void} [args.onProgress]
 */
export function buildTriggerBatch({
  asOf, idsite, sessions, overrides = {}, recorded = [], withChains = true, onProgress,
}) {
  const definitions = resolveDefinitions(overrides, recorded);
  const byKey = new Map(definitions.map((row) => [row.key, row]));
  const visits = dedupe(sessions);
  const byDate = groupByDate(visits);
  const visitors = indexVisitors(visits);
  const openHits = [];
  for (const definition of definitions) {
    const span = definition.predicate.chain_window_days;
    if (span == null) throw new Error(`${definition.key} predicate is missing chain_window_days`);
    for (const day of eachDate(addDays(asOf, -span), asOf)) {
      const dayHits = hitsOn(definition, day, byKey, idsite, byDate, visitors, onProgress);
      for (let i = 0; i < dayHits.length; i += 1) openHits.push(dayHits[i]);
    }
  }
  const purchase = purchasePredicate(byKey);
  /** @type {object[]} */
  const chains = [];
  if (withChains) {
    let chainN = 0;
    for (const hit of openHits) {
      chainN += 1;
      if (atStride(chainN, PROGRESS_STRIDE)) {
        onProgress?.({ phase: 'chain-outcomes', day: asOf, done: chainN, total: openHits.length });
      }
      chains.push({
        ...hit,
        ...chainFields(chainOutcome(
          hit,
          byKey.get(hit.triggerKey).predicate,
          purchase,
          sessionsFor(hit, visitors),
          asOf,
        )),
      });
    }
  }
  return {
    definitions,
    hits: openHits.filter((hit) => hit.serverDate === asOf),
    chains,
  };
}

/**
 * Hits and chains for a batch window. One day's `buildTriggerBatch` only
 * returns chains still open on that day, so a multi-day collect has to keep
 * the latest evaluation of each hit: the day its window closes, when that
 * day falls inside the batch, otherwise the batch's last day. The last day
 * also refreshes hits from before `windowStart` that are still open, which
 * is the entire chain set when the batch is a single day.
 *
 * @param {object} args
 * @param {string} args.windowStart
 * @param {string} args.windowEnd
 * @param {number} args.idsite
 * @param {object[]} args.sessions
 * @param {Record<string, object>} [args.overrides]
 * @param {object[]} [args.recorded]
 * @param {(fields: object) => void} [args.onProgress]
 */
export function collectTriggerWindow({
  windowStart, windowEnd, idsite, sessions, overrides = {}, recorded = [], onProgress,
}) {
  const days = eachDate(windowStart, windowEnd);
  const tick = progressEvery(onProgress);
  const started = Date.now();
  /** @type {object[]} */
  const hits = [];
  /** @type {Map<string, object>} */
  const chainByIdentity = new Map();
  let definitions = resolveDefinitions(overrides, recorded);
  /** @type {object[]} */
  let lastChains = [];
  for (let i = 0; i < days.length; i += 1) {
    const day = days[i];
    const batch = buildTriggerBatch({
      asOf: day, idsite, sessions, overrides, recorded, withChains: true, onProgress: tick,
    });
    for (let h = 0; h < batch.hits.length; h += 1) hits.push(batch.hits[h]);
    definitions = batch.definitions;
    for (const chain of batch.chains) {
      if (chain.serverDate < windowStart) continue;
      chainByIdentity.set(chainIdentity(chain), chain);
    }
    lastChains = batch.chains;
    onProgress?.({
      phase: 'classify',
      day,
      done: i + 1,
      total: days.length,
      hits: hits.length,
      chains: chainByIdentity.size,
      seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    });
  }
  for (const chain of lastChains) chainByIdentity.set(chainIdentity(chain), chain);
  const chains = [];
  for (const chain of chainByIdentity.values()) chains.push(chain);
  return { definitions, hits, chains };
}

/** @param {object} chain */
export function chainIdentity(chain) {
  return [chain.triggerKey, chain.serverDate, chain.idvisit, chain.configId].join('\0');
}

/**
 * @param {Map<string, object>} byKey
 */
export function purchasePredicate(byKey) {
  const pool = [...byKey.values(), ...DEFAULT_TRIGGERS];
  const named = pool.find((row) => Array.isArray(row.predicate?.purchase_events));
  if (!named) throw new Error('no trigger defines purchase_events');
  return named.predicate;
}

/**
 * @param {object} definition
 * @param {string} day
 * @param {Map<string, object>} byKey
 * @param {number} idsite
 * @param {Map<string, object[]>} byDate
 * @param {{ byConfig: Map<string, object[]>, datesByConfig: Map<string, Set<string>> }} visitors
 * @param {(fields: object, force?: boolean) => void} [onProgress]
 */
export function hitsOn(definition, day, byKey, idsite, byDate, visitors, onProgress) {
  if (definition.level === 'session') {
    return (byDate.get(day) ?? [])
      .filter((session) => qualifies(definition, session))
      .map((session) => hitFrom(definition, session, idsite));
  }
  if (definition.level !== 'visitor') {
    throw new Error(`${definition.key} has unknown level "${definition.level}"`);
  }
  const interest = byKey.get(definition.predicate.interest_trigger);
  const purchase = byKey.get(definition.predicate.purchase_trigger);
  /** @type {object[]} */
  const hits = [];
  let seen = 0;
  for (const [configId, list] of visitors.byConfig) {
    seen += 1;
    if (atStride(seen, PROGRESS_STRIDE)) {
      onProgress?.({ phase: 'visitor-hits', trigger: definition.key, day, done: seen, total: visitors.byConfig.size });
    }
    if (!visitors.datesByConfig.get(configId)?.has(day)) continue;
    if (!interest || !purchase) {
      throw new Error(`${definition.key} names a trigger that is not active`);
    }
    const ok = qualifies(definition, list[0], {
      interest: interest.predicate,
      purchase: purchase.predicate,
      sessions: list,
      asOf: day,
    });
    if (!ok) continue;
    hits.push(hitFrom(definition, seedSession(list, day, interest.predicate), idsite));
  }
  return hits;
}

/**
 * The session on `day` that carries the hit's dimensions. Prefer a
 * showed-interest session, then the latest start.
 * @param {object[]} sessions
 * @param {string} day
 * @param {object} interestPredicate
 */
function seedSession(sessions, day, interestPredicate) {
  const today = sessions.filter((session) => session.serverDate === day);
  const interested = today.filter((session) => qualifies({ predicate: interestPredicate }, session));
  const pool = interested.length > 0 ? interested : today;
  return pool.reduce((latest, session) => (startsAfter(session, latest) ? session : latest));
}

/** @param {object} session @param {object} other */
function startsAfter(session, other) {
  if (session.startedAt != null && other.startedAt != null && session.startedAt !== other.startedAt) {
    return session.startedAt > other.startedAt;
  }
  return String(session.idvisit) > String(other.idvisit);
}

/**
 * @param {object} definition
 * @param {object} session
 * @param {number} idsite
 */
function hitFrom(definition, session, idsite) {
  return {
    idsite,
    triggerKey: definition.key,
    serverDate: session.serverDate,
    triggerVersion: definition.version,
    idvisit: String(session.idvisit),
    configId: session.configId ?? '',
    level: definition.level,
    device: session.device ?? '',
    channel: session.channel ?? '',
    source: session.source ?? '',
    medium: session.medium ?? '',
    returning: session.returning ?? '',
    country: session.country ?? '',
    landingPage: session.landingPage ?? '',
    entryTemplate: session.entryTemplate ?? '',
    startedAt: session.startedAt ?? null,
  };
}

/** @param {object} outcome */
export function chainFields(outcome) {
  return {
    returned: outcome.returned,
    sessionsUntilReturn: outcome.sessionsUntilReturn,
    sessionsUntilPurchase: outcome.sessionsUntilPurchase,
    purchased: outcome.purchased,
    revenue: outcome.revenue,
    secondsToPurchase: outcome.secondsToPurchase,
    recovered: outcome.recovered,
    windowDays: outcome.windowDays,
    windowCloses: outcome.windowCloses,
    final: outcome.final,
  };
}

/** @param {object[]} sessions */
function dedupe(sessions) {
  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const session of sessions) {
    const key = String(session.idvisit);
    if (!byId.has(key)) byId.set(key, session);
  }
  return [...byId.values()];
}

/**
 * Sessions in visit order, keyed by server date.
 * @param {object[]} visits
 */
function groupByDate(visits) {
  /** @type {Map<string, object[]>} */
  const byDate = new Map();
  for (const session of visits) {
    const list = byDate.get(session.serverDate) ?? [];
    list.push(session);
    byDate.set(session.serverDate, list);
  }
  return byDate;
}

/**
 * Visitors keyed by config id, in first-seen order. Blank ids are left out,
 * matching the rule that a blank id is not a visitor and does not chain.
 * @param {object[]} visits
 */
function indexVisitors(visits) {
  /** @type {Map<string, object[]>} */
  const byConfig = new Map();
  /** @type {Map<string, Set<string>>} */
  const datesByConfig = new Map();
  for (const session of visits) {
    if (!session.configId) continue;
    const list = byConfig.get(session.configId);
    if (list) list.push(session);
    else byConfig.set(session.configId, [session]);
    const dates = datesByConfig.get(session.configId) ?? new Set();
    dates.add(session.serverDate);
    datesByConfig.set(session.configId, dates);
  }
  return { byConfig, datesByConfig };
}

/**
 * The sessions chainOutcome is allowed to see for this hit. A blank
 * config id gets an empty list so it cannot chain to another blank id.
 * @param {object} hit
 * @param {{ byConfig: Map<string, object[]> }} visitors
 */
export function sessionsFor(hit, visitors) {
  if (!hit.configId) return [];
  return visitors.byConfig.get(hit.configId) ?? [];
}

export { dayDiff };
