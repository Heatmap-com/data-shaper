import { deepFreeze } from '../freeze.js';

/**
 * The fields a segmentation can read. Each is one value per visit, taken at
 * the visit's first action unless it says otherwise. The registry holds the
 * name, type, and meaning; it holds no SQL. Each grain maps a field to its
 * own column in a column map, because the same field has a different alias
 * in the trend query and in the bundle. Device is not a field: it is
 * `viewport_type`.
 *
 * `needs` names a shared CTE the field reads in the trend queries: `orders`,
 * `checkout`, or `ragers`.
 *
 * @type {Readonly<Record<string, import('./conditions.js').FieldSpec>>}
 */
export const FIELDS = deepFreeze({
  referer_type: { type: 'number', source: 'udp_hsrce_visits.referer_type: 1 direct, 2 search, 3 website, 6 campaign, 7 social; 0 when missing' },
  referer_name: { type: 'string', source: 'udp_hsrce_visits.referer_name, lowercased and trimmed' },
  utm_source: { type: 'string', source: 'the session tags (udp_session_tags) utm_source, else udp_hsrce_visits.custom_var_k5; lowercased and trimmed' },
  source_or_referrer: { type: 'string', source: 'utm_source when it is not empty, else referer_name' },
  utm_medium: { type: 'string', source: 'the session tags utm_medium, else udp_hsrce_visits.custom_var_v1; lowercased and trimmed (D-14)' },
  utm_campaign: { type: 'string', source: 'the session tags utm_campaign, else udp_hsrce_visits.custom_var_v4; trimmed' },
  returning: { type: 'number', source: 'udp_hsrce_visits.visitor_returning: 1 returning, 0 new or missing' },
  country: { type: 'string', source: 'udp_hsrce_visits.location_country, trimmed' },
  has_order: { type: 'number', source: 'udp_conversions over the window: 1 when the visit has an order', needs: 'orders' },
  has_checkout: { type: 'number', source: 'journey_events_map checkout_started over the window: 1 when the visit started checkout', needs: 'checkout' },
  has_rage_click: { type: 'number', source: "udp_clicksce_clicks meta1 = 'rage' over the window: 1 when the visit has a rage click", needs: 'ragers' },
});
