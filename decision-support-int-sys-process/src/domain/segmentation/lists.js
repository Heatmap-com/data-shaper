import { deepFreeze } from '../freeze.js';

/**
 * Value lists a condition names as "@name" in place of an `in` array. Two
 * Meta source lists exist because the first trend delivery and the bundle's
 * link channel spelled Meta differently; each segmentation keeps its own,
 * so its stored meaning does not move. Editing a list changes the stamp of
 * every segmentation that reads it.
 */
export const LISTS = deepFreeze({
  meta_utm_sources_trend: ['facebook', 'ig', 'fb', 'instagram', 'facebookads'],
  meta_utm_sources: ['facebook', 'facebookads', 'ig', 'instagram', 'igshopping'],
  meta_referers: ['facebook', 'instagram'],
  paid_mediums: ['paid', 'paidsocial', 'paid_social'],
});
