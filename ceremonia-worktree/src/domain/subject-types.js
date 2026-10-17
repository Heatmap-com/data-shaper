import { deepFreeze } from './freeze.js';

/**
 * The grains one analyzed unit can have. `keyKind` names what the subject
 * key holds. `capture` says the subject is a page that renders and names;
 * `pageAnalysis` says it writes an ae_page_analysis row. Profiles such as
 * pdp, collection, and lp are page subjects with their own selector and
 * catalogs; a new grain is one entry here plus a selector.
 */
export const SUBJECT_TYPES = deepFreeze({
  page: { keyKind: 'idsitehsr', capture: true, pageAnalysis: true, keyPrefix: '' },
  quiz: { keyKind: 'idsitehsr', capture: true, pageAnalysis: true, keyPrefix: '' },
  experiment: { keyKind: 'experiment_key', capture: false, pageAnalysis: false, keyPrefix: 'exp:' },
  funnel: { keyKind: 'funnel_id', capture: false, pageAnalysis: false, keyPrefix: 'fn:' },
  journey: { keyKind: 'journey_id', capture: false, pageAnalysis: false, keyPrefix: 'jr:' },
});

export const isSubjectType = (type) => Object.hasOwn(SUBJECT_TYPES, type);

/** A page-shaped subject carries an idsitehsr and runs the page datasets. */
export const isPageShaped = (type) => isSubjectType(type) && SUBJECT_TYPES[type].keyKind === 'idsitehsr';

/**
 * The stored subject key. A page-shaped key is the idsitehsr as text; any
 * other carries its type's prefix, so keys of two types never collide.
 * @param {string} type
 * @param {string | number} id
 */
export function subjectKey(type, id) {
  if (!isSubjectType(type)) throw new Error(`unknown subject type "${type}"; known: ${Object.keys(SUBJECT_TYPES).join(', ')}`);
  const text = String(id);
  if (text === '') throw new Error(`subject key for ${type} is empty`);
  const { keyPrefix } = SUBJECT_TYPES[type];
  return text.startsWith(keyPrefix) ? text : `${keyPrefix}${text}`;
}
