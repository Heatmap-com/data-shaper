import { fetchHsrPages } from '../_lib/urls.js';
import { collectTriggerWindow } from '../../triggers/batch.js';
import { resolveDefinitions } from '../../triggers/definitions.js';
import { assembleLoaded, assembleSessions } from '../../triggers/facts.js';
import { createTriggerFolder } from '../../triggers/fold.js';
import {
  eventNames,
  loadPriorPurchases,
  loadTriggerFacts,
  overridesFrom,
  purchaseRule,
  scanWindow,
} from '../../triggers/load.js';
import { getTrigger, listTriggers, queryTriggerTrends } from '../../triggers/query.js';
import { triggerInputsOf } from '../../scan/views.js';

export { getTrigger, listTriggers, queryTriggerTrends };

/**
 * trigger-chains: one row per trigger hit in the batch window. The chain is
 * the outcome on the day the window closes, or on the batch's last day when
 * the window is still open. Rates, segments, and week-over-week deltas are
 * read through queryTriggerTrends, which is the same function the MCP,
 * FACETs, and the dashboard call.
 *
 * The daily job is this collect. A rerun of the same window writes the same
 * hit and chain identities. Chains stay final=0 until the window closes.
 *
 * On the day scan the dataset folds its own lane (open): it starts the
 * visitor window before the first hit day and evaluates each day once its
 * visits have closed, with the hits and chains collect computes.
 */

export const adapter = {
  id: 'trigger-chains',
  dependsOn: [],
  scope: 'site',
  provides: [],
  pass: 'site',

  /**
   * @param {{idsite: number, siteName?: string}} page
   * @param {import('../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const idsite = page.idsite;
    const recorded = await recordedDefinitions(ctx, idsite);
    const loaded = await loadTriggerFacts(ctx, idsite, recorded);
    const onProgress = progressLogger(ctx, idsite);
    const sessions = assembleLoaded(loaded, onProgress);
    const result = collectTriggerWindow({
      windowStart: ctx.windowStart,
      windowEnd: ctx.windowEnd,
      idsite,
      sessions,
      overrides: overridesFrom(recorded),
      recorded,
      onProgress,
    });
    return written(ctx, idsite, result, loaded.bounds.lookbackDays);
  },

  /**
   * The trigger lane: prior purchases are read here, the lane's visits
   * arrive as they close, and finish writes the batch.
   * @param {{idsite: number}} page
   * @param {import('../../ports/dataset.js').RunContext} ctx
   * @returns {Promise<import('../../ports/dataset.js').SessionFolder>}
   */
  async open(page, ctx) {
    const idsite = page.idsite;
    const recorded = await recordedDefinitions(ctx, idsite);
    const overrides = overridesFrom(recorded);
    const definitions = resolveDefinitions(overrides, recorded);
    const bounds = scanWindow(ctx.windowStart, ctx.windowEnd, definitions);
    const names = eventNames(definitions);
    const urls = await fetchHsrPages(ctx, idsite);
    const prior = bounds.purchaseEnd >= bounds.purchaseStart
      ? await loadPriorPurchases(ctx, idsite, bounds, names, purchaseRule(definitions))
      : { visits: [], events: [], orders: [] };
    const priorSessions = assembleLoaded({ visits: [], pageviews: [], clicks: [], events: [], orders: [], tags: [], urls, prior });
    let folder = createTriggerFolder({
      windowStart: ctx.windowStart,
      windowEnd: ctx.windowEnd,
      idsite,
      bounds,
      overrides,
      recorded,
      prior: priorSessions,
    });
    const triggerEvents = new Set(names);
    /** @type {ReturnType<typeof folder.finish> | null} */
    let settled = null;
    return {
      snapshot: () => folder.snapshot(),
      restore: (saved) => folder.restore(saved),
      settle() {
        settled ??= folder.finish();
        folder = null;
      },
      lane: {
        start: bounds.laneStart,
        events: names,
        onClosed(visits) {
          folder.add(assembleSessions({ ...triggerInputsOf(visits, triggerEvents), urls }));
        },
        onDay(day, open) {
          folder.advance(day, open.earliestOpen());
        },
      },
      async finish(_page, finishCtx) {
        const { peakRetained, ...result } = settled ?? folder.finish();
        finishCtx.logger?.info?.({ idsite, laneStart: bounds.laneStart, peakRetained, hits: result.hits.length }, 'trigger-chains lane');
        return written(finishCtx, idsite, result, bounds.lookbackDays);
      },
    };
  },
};

/**
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 */
async function recordedDefinitions(ctx, idsite) {
  return ctx.persistence?.readTriggerDefinitions ? ctx.persistence.readTriggerDefinitions(idsite) : [];
}

/**
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 */
function progressLogger(ctx, idsite) {
  const started = Date.now();
  return (fields) => {
    if (typeof ctx.logger?.info !== 'function') return;
    ctx.logger.info({
      idsite,
      ...fields,
      seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    }, 'trigger-chains progress');
  };
}

/**
 * Writes the trigger batch and returns the dataset.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @param {{definitions: object[], hits: object[], chains: object[]}} result
 * @param {number} lookbackDays
 */
async function written(ctx, idsite, { definitions, hits, chains }, lookbackDays) {
  if (typeof ctx.persistence?.writeTriggerBatch === 'function') {
    await ctx.persistence.writeTriggerBatch({
      definitions: definitions.map((row) => ({ ...row, idsite })),
      hits,
      chains,
    });
  }

  return {
    id: adapter.id,
    rows: chains.map(chainRow),
    notes: {
      trigger_chains_note:
        'Warehouse columns are idsite, idvisit, config_id, and server_date. Multi-dimension week-over-week rates are queryTriggerTrends; ae_trend_row remains one segment per row.',
      trigger_definitions: definitions.map((row) => ({ key: row.key, version: row.version })),
      trigger_lookback_days: lookbackDays,
      trigger_hits: hits.length,
      trigger_chains: chains.length,
      trigger_chains_open: chains.filter((chain) => !chain.final).length,
    },
  };
}

/** @param {object} chain */
function chainRow(chain) {
  return {
    dims: {
      trigger_key: chain.triggerKey,
      server_date: chain.serverDate,
      idvisit: chain.idvisit,
      config_id: chain.configId,
      trigger_version: String(chain.triggerVersion),
      device: chain.device,
      channel: chain.channel,
      returning: chain.returning,
    },
    metrics: {
      level: chain.level,
      returned: chain.returned ? 1 : 0,
      sessions_until_return: chain.sessionsUntilReturn,
      sessions_until_purchase: chain.sessionsUntilPurchase,
      purchased: chain.purchased ? 1 : 0,
      revenue: chain.revenue,
      seconds_to_purchase: chain.secondsToPurchase,
      recovered: chain.recovered ? 1 : 0,
      window_days: chain.windowDays,
      window_closes: chain.windowCloses,
      final: chain.final ? 1 : 0,
    },
  };
}
