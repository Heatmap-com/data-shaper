/**
 * card-history: the site's strategy cards from every prior batch — one
 * row per (catalog, strategy, segment), latest verdict and trigger state
 * by generated_at, the batch id that produced them, how many batches the
 * cell has been seen in, and its last metric/value. This is H26's history
 * leg (step-change detection, multi-period confidence); the weekly grains
 * live in the other datasets. Read through the gateway because the
 * RunContext does not carry persistence. Capped at 500 rows; zero rows on
 * a fresh install are a normal result, not a failure.
 */

import { configuredDatabase } from '../query-gateway/clickhouse.js';

const ROW_CAP = 500;

export const adapter = {
  id: 'card-history',
  dependsOn: [],
  scope: 'site',
  provides: ['H26'],

  /**
   * @param {{idsite: number, siteName: string}} page site-level page arg
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    // The _current view folds to the latest row per (batch, site, page,
    // catalog, strategy, segment); grouping by strategy/segment across
    // batches re-exposes the per-batch series for batches_seen and picks
    // the newest verdict by generated_at.
    let cards;
    try {
      cards = await ctx.gateway.query(
      `SELECT catalog_id,
              strategy_id,
              segment_key,
              uniqExact(batch_id) AS batches_seen,
              argMax(verdict, generated_at) AS last_verdict,
              argMax(trigger_state, generated_at) AS last_trigger_state,
              argMax(batch_id, generated_at) AS last_batch_id,
              argMax(metric, generated_at) AS last_metric,
              argMax(value, generated_at) AS last_value,
              max(generated_at) AS last_generated_at
         FROM ${configuredDatabase()}.ae_strategy_card_current
        WHERE idsite = {idsite:UInt32}
        GROUP BY catalog_id, strategy_id, segment_key
        ORDER BY last_generated_at DESC, catalog_id, strategy_id, segment_key
        LIMIT {cap:UInt16}`,
      { idsite: page.idsite, cap: ROW_CAP },
      'card-history:cards',
      );
    } catch (err) {
      // Pre-cutover clusters have no ae_ tables: zero cards is a result,
      // not a failure (same contract as element-binding).
      if (!/UNKNOWN_TABLE|Unknown table/i.test(String(err?.message ?? err))) throw err;
      cards = [];
    }

    const rows = cards.map((c) => ({
      dims: {
        catalog_id: String(c.catalog_id ?? ''),
        strategy_id: String(c.strategy_id ?? ''),
        segment_key: String(c.segment_key ?? 'all'),
        last_batch_id: String(c.last_batch_id ?? ''),
      },
      metrics: {
        batches_seen: Number(c.batches_seen ?? 0),
        last_verdict: String(c.last_verdict ?? ''),
        last_trigger_state: String(c.last_trigger_state ?? ''),
        metric: String(c.last_metric ?? ''),
        value: c.last_value == null ? null : Number(c.last_value),
      },
    }));

    const notes = { card_history_rows: rows.length };
    if (rows.length >= ROW_CAP) notes.card_history_capped = `rows capped at ${ROW_CAP}`;
    return { id: adapter.id, rows, notes };
  },
};
