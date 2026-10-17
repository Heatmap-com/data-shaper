/**
 * Phase-0 style checks, memoized on ctx.batchNotes:
 * - time_since_load unit (milliseconds, seconds, or unknown)
 * - scroll_y_max_relative scale (0-1000 means 0-100 percent)
 * Plus small exact statistics helpers used by the session datasets.
 */

/**
 * @param {number[]} sorted
 * @param {number} q 0..1
 */
export function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** @param {number[]} values */
export function median(values) {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

/**
 * time_since_load unit from a sample of values, per the data plan: state
 * milliseconds, seconds, or unknown; never guess a conversion.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 * @returns {Promise<'ms'|'s'|'unknown'>}
 */
export async function timeSinceLoadUnit(ctx, page) {
  const memoKey = `check:tsl-unit:${page.idsite}:${page.idsitehsr}`;
  if (ctx.batchNotes.has(memoKey)) return ctx.batchNotes.get(memoKey);
  const load = (async () => {
    const rows = await ctx.gateway.query(
      `SELECT min(t) AS mn, quantile(0.5)(t) AS p50, max(t) AS mx
         FROM (
           SELECT time_since_load AS t
             FROM default.udp_clicksce_clicks
            WHERE idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}
              AND server_date BETWEEN {w0:Date} AND {w1:Date} AND time_since_load > 0
            LIMIT 100000
         )`,
      { idsite: page.idsite, idsitehsr: page.idsitehsr, w0: ctx.windowStart, w1: ctx.windowEnd },
      'check:time-since-load-unit',
    );
    const r = rows[0];
    if (!r || r.p50 == null) return 'unknown';
    const p50 = Number(r.p50);
    const mx = Number(r.mx ?? 0);
    if (p50 >= 300 || mx > 10000) return 'ms';
    if (p50 <= 120) return 's';
    return 'unknown';
  })();
  ctx.batchNotes.set(memoKey, load);
  return load;
}

/**
 * The scroll scale check: values above 100 prove the 0-1000 = 0-100%
 * reading, matching the landing README. Until this returns true, scroll
 * thresholds must not drive a trigger rule.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 */
export async function scrollScaleConfirmed(ctx, page) {
  const memoKey = `check:scroll-scale:${page.idsite}:${page.idsitehsr}`;
  if (ctx.batchNotes.has(memoKey)) return ctx.batchNotes.get(memoKey);
  const load = (async () => {
    const rows = await ctx.gateway.query(
      `SELECT max(scroll_y_max_relative) AS mx
         FROM default.udp_hsrce_pageviews
        WHERE idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}
          AND server_date BETWEEN {w0:Date} AND {w1:Date}`,
      { idsite: page.idsite, idsitehsr: page.idsitehsr, w0: ctx.windowStart, w1: ctx.windowEnd },
      'check:scroll-scale',
    );
    return Number(rows[0]?.mx ?? 0) > 100;
  })();
  ctx.batchNotes.set(memoKey, load);
  return load;
}

/**
 * Requires columns on a table; returns the missing ones. Datasets use this
 * to stay blocked (a result, not a failure) when a column is absent.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {string} table
 * @param {string[]} needed
 */
export async function missingColumns(ctx, table, needed) {
  const columns = await ctx.gateway.columns(table);
  const have = new Set(columns.map((c) => c.name));
  return needed.filter((c) => !have.has(c));
}
