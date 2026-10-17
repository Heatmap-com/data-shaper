/**
 * ad-creative: the site's ad creative facts from ae_src_ad_creative_current
 * (A01, plan §4.6), site scope. One row per ad; campaign_id rides in
 * dim_extra so the grain stays (platform, utm_source, temperature) plus the
 * ad id in metrics. Phase 5 has no ad API connector yet — the table is fed
 * by the operator UTM map (examples/ad-creative-map.json) — so zero rows
 * are a normal result: the adapter emits an explicit A01 requirement
 * status 'missing' and message-match cards stay conditional. Pre-cutover
 * the ae_ table does not exist: the read degrades to the same zero rows
 * plus a note, never a throw.
 */

import { configuredDatabase } from '../query-gateway/clickhouse.js';

export const adapter = {
  id: 'ad-creative',
  dependsOn: [],
  scope: 'site',
  provides: ['A01'],

  /**
   * @param {{idsite: number, siteName: string}} page site-level page arg
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    /** @type {Array<object>} */
    let ads;
    try {
      ads = await ctx.gateway.query(
        `SELECT platform, ad_id, campaign_id, utm_source, temperature,
                destination_url, offer_text, has_code, offer_led, creator,
                angle, captured_at, provenance
           FROM ${configuredDatabase()}.ae_src_ad_creative_current
          WHERE idsite = {idsite:UInt32}
          ORDER BY platform, ad_id`,
        { idsite: page.idsite },
        'ad-creative:rows',
      );
    } catch (err) {
      if (!/UNKNOWN_TABLE|Unknown table/i.test(String(err?.message ?? err))) throw err;
      ads = [];
      return {
        id: adapter.id,
        rows: [],
        notes: { ad_creative_note: `ae_src_ad_creative_current unreadable: ${err.message}` },
        requirements: [missingA01()],
      };
    }

    if (ads.length === 0) {
      return {
        id: adapter.id,
        rows: [],
        notes: { ad_creative_ads: 0 },
        requirements: [missingA01()],
      };
    }

    const rows = ads.map((r) => ({
      dims: {
        platform: String(r.platform ?? ''),
        campaign_id: String(r.campaign_id ?? ''),
        utm_source: String(r.utm_source ?? ''),
        temperature: String(r.temperature ?? ''),
      },
      metrics: {
        ad_id: String(r.ad_id ?? ''),
        destination_url: String(r.destination_url ?? ''),
        offer_text: String(r.offer_text ?? ''),
        has_code: Number(r.has_code ?? 0),
        offer_led: Number(r.offer_led ?? 0),
        creator: String(r.creator ?? ''),
        angle: String(r.angle ?? ''),
        captured_at: r.captured_at ?? null,
        provenance: String(r.provenance ?? ''),
      },
    }));

    return { id: adapter.id, rows, notes: { ad_creative_ads: rows.length } };
  },
};

/** A01 with no operator map and no ad API ingested yet (plan §4.6, Q13). */
function missingA01() {
  return {
    key: 'A01',
    status: 'missing',
    rowCount: 0,
    detail: 'operator UTM map or ad API not imported (Q13)',
  };
}
