/**
 * The F1 site KPI pull the funnel and context stages both read, and the
 * site conversion-rate change points it yields.
 */

import { interpretSiteKpis, trendSeries } from '../funnel.js';
import { siteKpiQuery } from '../queries/funnel.js';
import { changePointRows } from '../rank.js';
import { runQuery } from './run-query.js';

/**
 * @param {{query: Function}} gateway
 * @param {{brand: string, idsite: number, windows: object, events: object[]}} input
 * @returns {Promise<{kpis: Array<{dims: object, metrics: object}>, changePoints: object[], error: string | null}>}
 */
export async function siteKpiStage(gateway, { brand, idsite, windows, events }) {
  const f1 = await runQuery(gateway, siteKpiQuery(idsite, windows));
  if (f1.error) return { kpis: [], changePoints: [], error: f1.error };
  const kpis = interpretSiteKpis(f1.rows, windows);
  const series = trendSeries(kpis, windows);
  const changePoints = changePointRows(brand, series.weeks, series.cr, events, 'site_cr');
  return { kpis, changePoints, error: null };
}
