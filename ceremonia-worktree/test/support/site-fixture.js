/**
 * One small site in the warehouse tables `createLocalWarehouse` loads:
 * visits over 2026-09-07..09-14 on five pages. Some cross midnight, some
 * start the day before a 09-08..09-14 window, some buy, some click, carry
 * campaign tags, or sit in an A/B arm.
 */

export const IDSITE = 1;

export const PAGES = [
  [11, 'https://one.com/', 'Home'],
  [12, 'https://one.com/products/a', 'A'],
  [13, 'https://one.com/collections/c', 'C'],
  [14, 'https://one.com/cart', 'Cart'],
  [15, 'https://one.com/pages/lp', 'LP'],
];

/** Confirms the fingerprints ending in 3. */
export const BOT = {
  tierOf: (_week, fp) => (fp.endsWith('3') ? { tier: 'confirmed', reasons: ['probe'] } : null),
  notes: {},
};

/** @param {number} day */
const dateOf = (day) => `2026-09-${String(day).padStart(2, '0')}`;

export function warehouseRows() {
  const visits = [];
  const pageviews = [];
  const events = [];
  const orders = [];
  const clicks = [];
  const sessionTags = [];
  const partnerTags = [];
  let loghsr = 10_000;
  for (let i = 0; i < 48; i += 1) {
    const idvisit = 1000 + i;
    const day = 7 + (i % 8);
    const date = dateOf(day);
    const late = i % 6 === 0;
    const clockAt = late ? '23:58:00' : `${String(8 + (i % 12)).padStart(2, '0')}:00:00`;
    const entry = [15, 12, 15, 11, 13, 12, 15, 14][i % 8];
    const path = [entry, ...[[12], [13, 12], [], [15], [12, 14]][i % 5]];
    visits.push({
      idsite: IDSITE, idvisit, server_date: date, visit_first_action_time: `${date} ${clockAt}`,
      config_id: `c${i % 9}`, config_device_type: 1 + (i % 3), referer_type: 1 + (i % 3),
      visitor_returning: i % 4 === 0, location_country: ['us', 'ca', 'gb'][i % 3], location_city: 'x',
      config_resolution: '1920x1080', config_browser_name: 'CH', config_browser_version: '120',
      visit_entry_idaction_url: entry, custom_var_k5: i % 5 === 0 ? 'Google' : null,
    });
    const entryLog = loghsr - 1;
    path.forEach((hsr, step) => {
      const crosses = late && step > 0;
      const pvDate = crosses ? dateOf(day + 1) : date;
      const at = crosses ? `00:0${step}:00` : `${clockAt.slice(0, 3)}${String(step * 2).padStart(2, '0')}:00`;
      loghsr -= 1;
      pageviews.push({
        idsite: IDSITE, idvisit, idloghsr: loghsr, idsitehsr: hsr, server_date: pvDate, server_time: `${pvDate} ${at}`,
        time_on_page: (i % 4 === 0 ? 40_000 : 1000) * (step + 1) + i, scroll_y_max_relative: 100 * ((i + step) % 10),
        viewport_h_px: i % 7 === 0 ? null : [640, 800, 1000][(i + step) % 3],
      });
      if (crosses && step === 1) {
        visits.push({ ...visits.at(-1), server_date: pvDate, visit_first_action_time: `${date} ${clockAt}.5`, location_country: 'xx' });
        if (i % 2 === 0) {
          partnerTags.push({ idsite: IDSITE, idloghsr: idvisit, server_date: pvDate, experience_id: 'e1', variant_id: i % 4 === 0 ? 'a' : 'b' });
        }
      }
    });
    if (i % 4 !== 3) {
      for (let c = 0; c < 5; c += 1) {
        clicks.push({
          idsite: IDSITE, idvisit, idloghsr: entryLog, idsitehsr: entry, server_date: date, date, hour: '10',
          idselector: `s${c}`, meta1: '', a_x: 10 * c, a_y: 20 * c, time_since_load: 500 * (c + 1),
        });
      }
    }
    if (i % 3 === 0) {
      events.push({ idsite: IDSITE, idvisit, server_date: date, event_type: 'product_viewed', ts_ms: 1 });
      sessionTags.push({ idsite: IDSITE, idvisit, server_date: date, session_tags: `{"utm_source":"fb","utm_medium":"cpc","utm_campaign":"c${i % 2}"}` });
    }
    if (i % 11 === 0) sessionTags.push({ idsite: IDSITE, idvisit, server_date: date, session_tags: '{}' });
    if (i % 7 === 0) events.push({ idsite: IDSITE, idvisit, server_date: date, event_type: 'add_to_cart', ts_ms: 2 });
    if (i % 5 === 1) {
      orders.push({ idsite: IDSITE, idvisit, server_date: date, idorder: `o${i}`, revenue: 30 + i });
      events.push({ idsite: IDSITE, idvisit, server_date: date, event_type: 'checkout_completed', ts_ms: 3 });
    }
    if (i % 2 === 0) {
      const arm = { idsite: IDSITE, idloghsr: idvisit, server_date: date, experience_id: 'e1', variant_id: i % 4 === 0 ? 'a' : 'b' };
      partnerTags.push(arm);
      if (i % 8 === 0) partnerTags.push({ ...arm });
    }
  }
  partnerTags.push({ idsite: IDSITE, idloghsr: 99_999, server_date: dateOf(10), experience_id: 'e2', variant_id: 'x' });
  return {
    udp_hsrce_visits: visits,
    udp_hsrce_pageviews: pageviews,
    journey_events_map: events,
    udp_conversions: orders,
    udp_clicksce_clicks: clicks,
    udp_session_tags: sessionTags,
    udp_partner_tags: partnerTags,
    site_hsr: PAGES.map(([idsitehsr, screenshot_url, name]) => ({ idsite: IDSITE, idsitehsr, screenshot_url, name })),
  };
}
