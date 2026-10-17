import { missingColumns } from '../_lib/checks.js';

/**
 * coverage: one row per data source over the window. Counts and date ranges
 * only; a zero count is a result that keeps the dependent strategies
 * blocked, not a failure. No bot_filter on these rows.
 */

export const adapter = {
  id: 'coverage',
  dependsOn: [],
  scope: 'page',
  provides: ['H28'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const params = { idsite: page.idsite, w0: ctx.windowStart, w1: ctx.windowEnd };
    const rows = [];
    const notes = {};

    let urlPath = '';
    try {
      urlPath = page.url ? new URL(page.url).pathname : '';
    } catch {
      urlPath = '';
    }
    const speed = await ctx.gateway.query(
      `SELECT count() AS row_count, min(fetched_at) AS mn, max(fetched_at) AS mx
         FROM journey_events.page_speed_cache
        WHERE idsite = {idsite:UInt32}
          AND (url = {url:String} OR positionCaseInsensitive(url, {urlPath:String}) > 0)`,
      { ...params, url: page.url ?? '', urlPath },
      'coverage:page-speed',
    );
    const speedCount = Number(speed[0]?.row_count ?? 0);
    rows.push({
      dims: { source: 'page_speed_cache' },
      metrics: {
        row_count: speedCount,
        min_date: speedCount > 0 ? isoDate(speed[0]?.mn) : null,
        max_date: speedCount > 0 ? isoDate(speed[0]?.mx) : null,
      },
    });

    const missing = await missingColumns(ctx, 'udp_partner_tags', ['experience_id', 'variant_id', 'server_date']);
    if (missing.length > 0) {
      rows.push({
        dims: { source: 'udp_partner_tags' },
        metrics: {
          row_count: 0,
          distinct_experiences: 0,
          distinct_variants: 0,
          note: `missing columns: ${missing.join(', ')}`,
        },
      });
      notes.partner_tags_note = `missing columns: ${missing.join(', ')}`;
    } else {
      const partner = await ctx.gateway.query(
        `SELECT count() AS row_count,
                uniqExact(experience_id) AS distinct_experiences,
                uniqExact(variant_id) AS distinct_variants
           FROM default.udp_partner_tags
          WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}`,
        params,
        'coverage:partner-tags',
      );
      rows.push({
        dims: { source: 'udp_partner_tags' },
        metrics: {
          row_count: Number(partner[0]?.row_count ?? 0),
          distinct_experiences: Number(partner[0]?.distinct_experiences ?? 0),
          distinct_variants: Number(partner[0]?.distinct_variants ?? 0),
        },
      });
    }

    const custom = await ctx.gateway.query(
      `SELECT count() AS row_count, uniqExact(event_type) AS distinct_event_names
         FROM default.udp_custom_events
        WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}`,
      params,
      'coverage:custom-events',
    );
    rows.push({
      dims: { source: 'udp_custom_events' },
      metrics: {
        row_count: Number(custom[0]?.row_count ?? 0),
        distinct_event_names: Number(custom[0]?.distinct_event_names ?? 0),
      },
    });

    const viewport = await ctx.gateway.query(
      `SELECT count() AS n, countIf(viewport_w_px IS NULL OR viewport_h_px IS NULL) AS nulls
         FROM default.udp_hsrce_pageviews
        WHERE idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}
          AND server_date BETWEEN {w0:Date} AND {w1:Date}`,
      { ...params, idsitehsr: page.idsitehsr },
      'coverage:viewport',
    );
    const n = Number(viewport[0]?.n ?? 0);
    const nulls = Number(viewport[0]?.nulls ?? 0);
    rows.push({
      dims: { source: 'viewport' },
      metrics: {
        pageviews: n,
        viewport_null_share: n > 0 ? Math.round((nulls / n) * 10000) / 10000 : null,
        viewport_present: n - nulls > 0,
      },
    });

    return { id: adapter.id, rows, notes };
  },
};

/** @param {unknown} value ClickHouse DateTime serialized */
function isoDate(value) {
  if (value == null || value === '') return null;
  return String(value).slice(0, 10);
}
