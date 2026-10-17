/**
 * page-speed: lab page-speed rows for the page from
 * journey_events.page_speed_cache (Lighthouse-style columns; the table has
 * no server_date, coverage is by url match). Emits p50 LCP and FCP with
 * nulls when no rows match; zero rows on the pilots is the probed live
 * state (docs/probes/2026-10-04-phase-0.md, D-07); CrUX (A03 full fill)
 * arrives in Phase 9. H15, A03.
 */

export const adapter = {
  id: 'page-speed',
  dependsOn: [],
  scope: 'page',
  provides: ['H15', 'A03'],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    let urlPath = '';
    try {
      urlPath = page.url ? new URL(page.url).pathname : '';
    } catch {
      urlPath = '';
    }
    const rows = await ctx.gateway.query(
      `SELECT count() AS row_count,
             toString(min(fetched_at)) AS min_fetched_at,
             toString(max(fetched_at)) AS max_fetched_at,
             quantile(0.5)(lcp_ms) AS lcp_ms_p50,
             quantile(0.5)(fcp_ms) AS fcp_ms_p50
        FROM journey_events.page_speed_cache
       WHERE idsite = {idsite:UInt32}
         AND (url = {url:String} OR positionCaseInsensitive(url, {urlPath:String}) > 0)`,
      {
        idsite: page.idsite,
        url: page.url ?? '',
        urlPath,
      },
      'page-speed:rows',
    );
    const r = rows[0] ?? {};
    const rowCount = Number(r.row_count ?? 0);

    return {
      id: adapter.id,
      rows: [
        {
          dims: { device: 'all', source: 'page_speed_cache' },
          metrics: {
            row_count: rowCount,
            min_fetched_at: rowCount > 0 ? String(r.min_fetched_at ?? '') : null,
            max_fetched_at: rowCount > 0 ? String(r.max_fetched_at ?? '') : null,
            lcp_ms_p50: rowCount > 0 && r.lcp_ms_p50 != null ? round2(Number(r.lcp_ms_p50)) : null,
            fcp_ms_p50: rowCount > 0 && r.fcp_ms_p50 != null ? round2(Number(r.fcp_ms_p50)) : null,
          },
        },
      ],
      notes: {
        page_speed_coverage:
          'zero rows on pilots (docs/probes/2026-10-04-phase-0.md); CrUX arrives Phase 9',
      },
    };
  },
};

/** @param {number} n */
function round2(n) {
  return Math.round(n * 100) / 100;
}
