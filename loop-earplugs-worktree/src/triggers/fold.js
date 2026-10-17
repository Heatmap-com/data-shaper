import { chainFields, chainIdentity, hitsOn, purchasePredicate, sessionsFor } from './batch.js';
import { resolveDefinitions } from './definitions.js';
import { chainOutcome, sessionPurchased } from './evaluate.js';
import { addDays } from './time.js';

/**
 * collectTriggerWindow a day at a time. Sessions arrive as the day scan
 * closes their visits; a day is evaluated once every visit dated on or
 * before it has closed. The folder keeps, per visitor, the sessions of the
 * last `retainDays` days and the purchase sessions within the lookback, and
 * evaluates with the unchanged hitsOn and chainOutcome:
 *
 * - the hits of each day from `firstHitDay`, with the window's hits kept;
 * - each hit's chain once, on min(hit day + chain_window_days, windowEnd),
 *   the evaluation collectTriggerWindow keeps.
 *
 * @param {object} args
 * @param {string} args.windowStart
 * @param {string} args.windowEnd
 * @param {number} args.idsite
 * @param {ReturnType<typeof import('./load.js').scanWindow>} args.bounds
 * @param {Record<string, object>} [args.overrides]
 * @param {object[]} [args.recorded]
 * @param {object[]} [args.prior] assembled purchase sessions from before the lane
 */
export function createTriggerFolder({ windowStart, windowEnd, idsite, bounds, overrides = {}, recorded = [], prior = [] }) {
  const definitions = resolveDefinitions(overrides, recorded);
  const byKey = new Map(definitions.map((row) => [row.key, row]));
  const purchase = purchasePredicate(byKey);
  for (const definition of definitions) {
    if (definition.predicate.chain_window_days == null) throw new Error(`${definition.key} predicate is missing chain_window_days`);
  }

  /** @type {Map<string, object[]>} unevaluated days' sessions */
  const byDate = new Map();
  /** @type {Map<string, object[]>} retained sessions per visitor */
  const byConfig = new Map();
  /** @type {Map<string, object>} prior purchase sessions by idvisit, until the lane's copy arrives */
  const priorById = new Map();
  /** @type {Map<string, object[]>} hits by the day their chain is evaluated */
  const due = new Map();
  /** @type {object[]} */
  const hits = [];
  /** @type {Map<string, object>} */
  const chains = new Map();
  let next = bounds.firstHitDay;
  let peakRetained = 0;

  for (const session of prior) {
    if (priorById.has(session.idvisit)) continue;
    priorById.set(session.idvisit, session);
    keep(session);
  }

  /** @param {object} session */
  function keep(session) {
    if (!session.configId) return;
    const list = byConfig.get(session.configId);
    if (list) list.push(session);
    else byConfig.set(session.configId, [session]);
  }

  /**
   * A visit read both by the prior-purchase query and on the lane is one
   * session, as the window query reads it whole.
   * @param {object} earlier
   * @param {object} session
   */
  function merged(earlier, session) {
    const list = byConfig.get(earlier.configId) ?? [];
    const at = list.indexOf(earlier);
    if (at >= 0) list.splice(at, 1);
    priorById.delete(session.idvisit);
    return {
      ...session,
      serverDate: earlier.serverDate < session.serverDate ? earlier.serverDate : session.serverDate,
      startedAt: [earlier.startedAt, session.startedAt].filter((t) => t != null).sort((a, b) => a - b)[0] ?? null,
      events: [...new Set([...earlier.events, ...session.events])],
      orders: earlier.orders + session.orders,
      revenue: earlier.revenue + session.revenue,
    };
  }

  /** @param {string} day */
  function evaluate(day) {
    const sessions = byDate.get(day) ?? [];
    byDate.delete(day);
    const active = new Map();
    for (const session of sessions) {
      if (session.configId && !active.has(session.configId)) active.set(session.configId, byConfig.get(session.configId));
    }
    const dayView = new Map([[day, sessions]]);
    const visitors = { byConfig: active, datesByConfig: new Map([...active.keys()].map((id) => [id, new Set([day])])) };
    for (const definition of definitions) {
      if (day < firstHitDayOf(definition)) continue;
      for (const hit of hitsOn(definition, day, byKey, idsite, dayView, visitors)) {
        if (day >= windowStart) hits.push(hit);
        const asOf = [addDays(day, definition.predicate.chain_window_days), windowEnd].sort()[0];
        const list = due.get(asOf) ?? [];
        list.push(hit);
        due.set(asOf, list);
      }
    }
    for (const hit of due.get(day) ?? []) {
      const outcome = chainOutcome(hit, byKey.get(hit.triggerKey).predicate, purchase, sessionsFor(hit, { byConfig }), day);
      chains.set(chainIdentity(hit), { ...hit, ...chainFields(outcome) });
    }
    due.delete(day);
    evict(addDays(day, 1));
  }

  /**
   * Keeps what the next day reads: sessions from retainDays before it, and
   * purchase sessions within the lookback.
   * @param {string} nextDay
   */
  function evict(nextDay) {
    const floor = addDays(nextDay, -bounds.retainDays);
    const purchaseFloor = addDays(nextDay, -bounds.lookbackDays);
    let retained = 0;
    for (const [configId, list] of byConfig) {
      const kept = list.filter((s) => s.serverDate >= floor || (s.serverDate >= purchaseFloor && sessionPurchased(purchase, s)));
      if (kept.length === 0) byConfig.delete(configId);
      else byConfig.set(configId, kept);
      retained += kept.length;
    }
    peakRetained = Math.max(peakRetained, retained);
  }

  /** @param {object} definition */
  function firstHitDayOf(definition) {
    return [windowStart, addDays(windowEnd, -definition.predicate.chain_window_days)].sort()[0];
  }

  return {
    definitions,
    /** @param {object[]} sessions assembled trigger sessions of closed visits */
    add(sessions) {
      for (const arrived of sessions) {
        const earlier = priorById.get(arrived.idvisit);
        const session = earlier ? merged(earlier, arrived) : arrived;
        keep(session);
        if (session.serverDate < next) continue;
        const list = byDate.get(session.serverDate) ?? [];
        list.push(session);
        byDate.set(session.serverDate, list);
      }
    },
    /**
     * Evaluates every day through `day` that is complete: no visit dated on
     * or before it is still open.
     * @param {string} day the last day read
     * @param {string | null} earliestOpen the earliest first day of an open visit
     */
    advance(day, earliestOpen) {
      while (next <= day && next <= windowEnd && (earliestOpen == null || earliestOpen > next)) {
        evaluate(next);
        next = addDays(next, 1);
      }
      if (next > day) evict(next);
    },
    /** The folder's state, for a day cursor; sessions are shared between its maps. */
    snapshot() {
      return { byDate, byConfig, priorById, due, hits, chains, next, peakRetained };
    },
    /** @param {ReturnType<this['snapshot']>} saved */
    restore(saved) {
      for (const [mine, theirs] of [[byDate, saved.byDate], [byConfig, saved.byConfig], [priorById, saved.priorById], [due, saved.due], [chains, saved.chains]]) {
        mine.clear();
        for (const [key, value] of theirs) mine.set(key, value);
      }
      hits.length = 0;
      for (const hit of saved.hits) hits.push(hit);
      next = saved.next;
      peakRetained = saved.peakRetained;
    },
    /** After the last day: every visit has closed. */
    finish() {
      while (next <= windowEnd) {
        evaluate(next);
        next = addDays(next, 1);
      }
      return { definitions, hits, chains: [...chains.values()], peakRetained };
    },
  };
}
