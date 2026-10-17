import { createPageClassifier } from './domain/page-class/index.js';

/**
 * Page-type classifier over the Shopify preset in src/domain/page-class.
 * The ClickHouse twin is pageClassSql with the same rules.
 *
 * @type {(url: unknown) => 'home'|'product'|'collection'|'cart'|'search'|'content'|'checkout'|'account'|'other'|'unknown'}
 */
export const pageType = /** @type {any} */ (createPageClassifier());
