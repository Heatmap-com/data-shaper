/**
 * A site for shaped datasets: four visits a day over six Monday weeks,
 * 2026-08-24..10-04, landing on four pages, with campaigns the synthetic
 * Meta Ads file names, a GA4-like spread of sources, orders, checkouts, and
 * some visits that cross midnight (and one that crosses a week).
 */

import { addDays } from '../../src/domain/shaping/dates.js';

export const SHAPE_SITE = 7;
export const FIRST_DAY = '2026-08-24';
export const LAST_DAY = '2026-10-04';
export const DAYS = 42;
export const CAMPAIGNS = ['fall_sale', 'retarget', 'brand', ''];

export const SHAPE_PAGES = [
  [71, 'https://seven.com/', 'Home'],
  [72, 'https://seven.com/products/linen-shirt?variant=3', 'Linen shirt'],
  [73, 'https://seven.com/collections/summer/', 'Summer'],
  [74, 'https://seven.com/pages/lookbook', 'Lookbook'],
  [75, 'https://seven.com/cart', 'Cart'],
];

const REFERRERS = ['google', '', 'instagram'];
const REGIONS = ['ny', 'on', 'ldn'];

export function shapingRows() {
  const visits = [];
  const pageviews = [];
  const events = [];
  const orders = [];
  let loghsr = 50_000;
  for (let d = 0; d < DAYS; d += 1) {
    const date = addDays(FIRST_DAY, d);
    for (let j = 0; j < 4; j += 1) {
      const i = d * 4 + j;
      const idvisit = 5000 + i;
      const campaign = CAMPAIGNS[(d + j) % 4];
      const source = campaign ? (j % 2 === 0 ? 'facebook' : 'google') : null;
      const crosses = i % 13 === 0;
      const clock = crosses ? '23:59:00' : `${String(9 + j * 3).padStart(2, '0')}:00:00`;
      const buys = i % 5 === 1;
      const entry = [72, 73, 74, 71][(i + d) % 4];
      const visit = {
        idsite: SHAPE_SITE, idvisit, server_date: date, visit_first_action_time: `${date} ${clock}`,
        config_id: `s${i % 17}`, config_device_type: 1 + (i % 3), referer_type: campaign ? 6 : [2, 1, 7][i % 3],
        visitor_returning: i % 4 === 0, location_country: ['us', 'ca', 'gb'][i % 3], location_city: 'x',
        location_region: REGIONS[i % 3],
        config_resolution: '1920x1080', config_browser_name: 'CH', config_browser_version: '120',
        custom_var_k5: source, custom_var_v1: campaign ? (source === 'facebook' ? 'paid' : 'cpc') : null,
        custom_var_v4: campaign || null, referer_name: campaign ? null : REFERRERS[i % 3],
      };
      visits.push(visit);
      const path = buys ? [entry, 75] : [entry];
      path.forEach((hsr, step) => {
        const next = crosses && step > 0;
        const pvDate = next ? addDays(date, 1) : date;
        loghsr -= 1;
        pageviews.push({
          idsite: SHAPE_SITE, idvisit, idloghsr: loghsr, idsitehsr: hsr, server_date: pvDate,
          server_time: `${pvDate} ${next ? '00:01:00' : `${clock.slice(0, 3)}${String(step * 2).padStart(2, '0')}:00`}`,
        });
      });
      if (crosses) {
        const pvDate = addDays(date, 1);
        visits.push({ ...visit, server_date: pvDate, visit_first_action_time: `${date} ${clock}.5` });
        if (!buys) {
          loghsr -= 1;
          pageviews.push({ idsite: SHAPE_SITE, idvisit, idloghsr: loghsr, idsitehsr: 71, server_date: pvDate, server_time: `${pvDate} 00:02:00` });
        }
      }
      if (buys || i % 5 === 2) events.push({ idsite: SHAPE_SITE, idvisit, server_date: date, event_type: 'checkout_started', ts_ms: 1 });
      if (buys) orders.push({ idsite: SHAPE_SITE, idvisit, server_date: date, idorder: `o${i}`, revenue: 50 + (i % 7) * 10 });
    }
  }
  return {
    udp_hsrce_visits: visits,
    udp_hsrce_pageviews: pageviews,
    journey_events_map: events,
    udp_conversions: orders,
    site_hsr: SHAPE_PAGES.map(([idsitehsr, screenshot_url, name]) => ({ idsite: SHAPE_SITE, idsitehsr, screenshot_url, name })),
  };
}
