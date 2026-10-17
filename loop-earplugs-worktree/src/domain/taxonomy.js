/**
 * Element taxonomy v2 (data-capture-plan.md §6.3): the 19 v1 classes kept,
 * 20 classes from PG §8, and 15 classes this plan adds — 54 classes total.
 * The naming bot must emit these strings. A display name is not a class.
 * Page-kind values (page, pdp, collection, landing) are not element classes.
 *
 * Deviation from the plan: §12 Phase 4 task 1 says `src/adapters/_lib/taxonomy.js`,
 * but persistence (both adapters) and the runner import this module already;
 * moving it under adapters/_lib would point src/domain at src/adapters and
 * invert the dependency direction. It upgrades in place here instead.
 */

export const TAXONOMY_VERSION = '2026-10-04.2';

export const NAMING_MAX_AGE_DAYS = 14;

/**
 * Kept from v1 (data-capture-plan.md §6.3 "Kept from v1 (19)"), in the
 * original order so existing stored names diff cleanly.
 */
export const V1_CLASSES = [
  'product_tile',
  'faq_item',
  'nav_link',
  'nav_toggle',
  'hero_cta',
  'promo_cta',
  'offer_add_to_cart',
  'bundle_product_add',
  'bundle_slot',
  'bundle_checkout',
  'cart_checkout',
  'express_checkout',
  'cart_drawer_close',
  'cart_upsell',
  'collection_tile',
  'content_section',
  'rewards_link',
  'email_subscribe',
  'announcement_bar',
];

/** Classes added from PG §8 (data-capture-plan.md §6.3 "From PG §8 (20)"). */
export const PG_CLASSES = [
  'gallery_item',
  'variant_option',
  'review_item',
  'review_summary',
  'filter_facet',
  'sort_control',
  'quantity_control',
  'search_control',
  'payment_option',
  'carousel_item',
  'carousel_control',
  'recommendation_tile',
  'product_price',
  'uvp_item',
  'form_field',
  'size_guide',
  'spec_item',
  'reassurance_item',
  'comparison_item',
  'urgency_element',
];

/** Classes added by this plan (data-capture-plan.md §6.3 "Added by this plan (15)"). */
export const PLAN_CLASSES = [
  'tab_control',
  'coupon_field',
  'subscription_toggle',
  'video_player',
  'popup_control',
  'sticky_atc',
  'quick_add',
  'router_option',
  'breadcrumb',
  'policy_link',
  'outbound_link',
  'protection_widget',
  'returns_portal_link',
  'cart_icon',
  'proof_badge',
];

export const ELEMENT_CLASSES = [...V1_CLASSES, ...PG_CLASSES, ...PLAN_CLASSES];

/**
 * Bounded element_role per class (data-capture-plan.md §6.3). Classes with no
 * role column in the plan's table have [] — role is not applicable there —
 * and isElementRole is always false for them.
 */
export const ELEMENT_ROLES = Object.freeze({
  nav_link: Object.freeze(['primary', 'submenu', 'footer', 'utility']),
  content_section: Object.freeze([
    'hero',
    'proof',
    'how_it_works',
    'comparison',
    'faq_block',
    'reviews_block',
    'story',
    'ingredients_specs',
    'guarantee',
    'founder',
    'ugc',
    'other',
  ]),
  payment_option: Object.freeze(['bnpl', 'express', 'wallet', 'card']),
  reassurance_item: Object.freeze(['shipping', 'returns', 'guarantee', 'security']),
  carousel_control: Object.freeze(['next', 'prev', 'dot', 'pause']),
  urgency_element: Object.freeze(['stock', 'timer', 'shipping_cutoff']),
  form_field: Object.freeze(['required', 'optional']),
  popup_control: Object.freeze(['open', 'dismiss', 'submit']),
  outbound_link: Object.freeze(['social', 'marketplace', 'other']),
  policy_link: Object.freeze(['shipping', 'returns', 'privacy', 'terms']),
  proof_badge: Object.freeze(['press', 'rating', 'units_sold', 'certification']),
});

/**
 * v1 → v2 class mapping: every v1 class survives unchanged, so the map is the
 * identity over V1_CLASSES (data-capture-plan.md §6.3).
 */
export const V1_TO_V2 = Object.freeze(
  Object.fromEntries(V1_CLASSES.map((elementClass) => [elementClass, elementClass])),
);

const CLASS_SET = new Set(ELEMENT_CLASSES);

/** @param {string} value */
export function isElementClass(value) {
  return CLASS_SET.has(value);
}

/**
 * The bounded role list for a class; [] when the class has no roles or is
 * not a taxonomy class at all.
 * @param {string} elementClass
 */
export function elementRoles(elementClass) {
  return ELEMENT_ROLES[elementClass] ?? [];
}

/**
 * True only when elementClass is a taxonomy class and role is inside its
 * bounded role list (§6.3: the role vocabulary is closed per class).
 * @param {string} elementClass
 * @param {string} role
 */
export function isElementRole(elementClass, role) {
  return elementRoles(elementClass).includes(role);
}
