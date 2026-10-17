/**
 * The reference seed of requirements, strategies, crosswalk, and screen rules.
 *
 * @typedef {Object} CatalogSeedStore
 * @property {(bundle: object) => Promise<void>} seedReference idempotent seed of ae_requirement, ae_strategy_catalog, ae_strategy_crosswalk, ae_screen_rule from the catalog bundle
 */

export const CATALOG_SEED_STORE = Object.freeze([
  'seedReference',
]);
