/**
 * The site fixture with the first-action fields every shipped segmentation
 * reads, varied per visit so each segmentation has each value at least once:
 * the UTM source cycles through the Meta spellings, the referrer type through
 * every code the rules name, and the referrer, medium, and campaign through
 * the values the channel rules test. Every third visit has a rage click.
 * Both rows of a visit that crosses midnight get the same fields.
 */

import { warehouseRows } from './site-fixture.js';

const SOURCES = ['facebook', 'ig', ' FB', 'instagram', 'facebookads', 'igshopping', 'klaviyo', '', null];
const REFERER_TYPES = [0, 1, 2, 3, 6, 7, 3, 5];
const REFERERS = ['Facebook', 'instagram', 'klaviyo', 'google', 'shopmy', '', null];
const MEDIUMS = ['paid', 'email', 'cpc', 'flow', '', null];
const CAMPAIGNS = ['fall_sale', ''];

export function variedWarehouseRows() {
  const rows = warehouseRows();
  const fieldsOf = (idvisit) => {
    const i = Number(idvisit) - 1000;
    return {
      custom_var_k5: SOURCES[i % SOURCES.length],
      referer_type: REFERER_TYPES[i % REFERER_TYPES.length],
      referer_name: REFERERS[i % REFERERS.length],
      custom_var_v1: MEDIUMS[i % MEDIUMS.length],
      custom_var_v4: CAMPAIGNS[i % CAMPAIGNS.length],
    };
  };
  const rageVisits = new Set();
  return {
    ...rows,
    udp_hsrce_visits: rows.udp_hsrce_visits.map((visit) => ({ ...visit, ...fieldsOf(visit.idvisit) })),
    udp_clicksce_clicks: rows.udp_clicksce_clicks.map((click) => {
      const i = Number(click.idvisit) - 1000;
      if (i % 3 !== 0 || rageVisits.has(click.idvisit)) return click;
      rageVisits.add(click.idvisit);
      return { ...click, meta1: 'rage' };
    }),
  };
}
