/**
 * Element classes the Roswell plan requires from the naming matrix.
 * These strings are the audit vocabulary. They are not the 54-class
 * capture taxonomy, and they do not bump TAXONOMY_VERSION.
 */

/** @type {Record<string, string[]>} */
export const REQUIRED_CLASSES = {
  home: [
    'home.hero_cta',
    'home.hero_slide',
    'home.hero_carousel_control',
    'home.category_tile',
    'home.product_tile',
    'home.product_carousel_control',
    'home.promo_banner',
    'home.value_props',
    'home.social_proof',
    'home.editorial_block',
    'home.inline_email_capture',
    'home.quiz_or_finder',
  ],
  plp: [
    'plp.product_tile_image',
    'plp.product_tile_title',
    'plp.quick_add',
    'plp.swatch',
    'plp.wishlist',
    'plp.filter_open',
    'plp.filter_option',
    'plp.sort_control',
    'plp.subcategory_link',
    'plp.load_more',
    'plp.collection_banner',
    'plp.breadcrumb',
    'plp.search_result_tile',
  ],
  pdp: [
    'pdp.gallery_main',
    'pdp.gallery_thumbnail',
    'pdp.gallery_zoom',
    'pdp.video',
    'pdp.variant_size',
    'pdp.variant_color',
    'pdp.size_guide',
    'pdp.quantity',
    'pdp.add_to_cart',
    'pdp.sticky_add_to_cart',
    'pdp.express_pay',
    'pdp.subscribe_option',
    'pdp.bnpl_message',
    'pdp.price_promo',
    'pdp.review_stars',
    'pdp.reviews_section',
    'pdp.content_tab',
    'pdp.shipping_returns',
    'pdp.recommendation_tile',
    'pdp.bundle_offer',
    'pdp.wishlist',
    'pdp.back_in_stock',
    'pdp.breadcrumb',
  ],
  cart_drawer: [
    'global.cart_icon',
    'cart.close',
    'cart.continue_shopping',
    'cart.line_item_link',
    'cart.quantity',
    'cart.remove',
    'cart.upsell_tile',
    'cart.free_shipping_bar',
    'cart.discount_code',
    'cart.gift_option',
    'cart.bnpl_message',
    'cart.checkout_button',
    'cart.express_checkout',
    'cart.view_cart_link',
  ],
  cart_page: [
    'global.cart_icon',
    'cart.close',
    'cart.continue_shopping',
    'cart.line_item_link',
    'cart.quantity',
    'cart.remove',
    'cart.upsell_tile',
    'cart.free_shipping_bar',
    'cart.discount_code',
    'cart.gift_option',
    'cart.bnpl_message',
    'cart.checkout_button',
    'cart.express_checkout',
    'cart.view_cart_link',
  ],
  checkout: [
    'checkout.express_pay',
    'checkout.login',
    'checkout.discount_field',
    'checkout.shipping_method',
    'checkout.payment_method',
    'checkout.order_summary_toggle',
    'checkout.return_to_cart',
  ],
  global: [
    'global.announcement_bar',
    'global.logo',
    'global.nav_item',
    'global.nav_menu_link',
    'global.mobile_menu_open',
    'global.search',
    'global.account',
    'global.cart_icon',
    'global.popup',
    'global.chat_widget',
    'global.cookie_banner',
    'global.locale_selector',
    'global.footer_link',
  ],
};

export const AUDIT_TEMPLATES = Object.keys(REQUIRED_CLASSES);

const CLASS_SET = new Set(Object.values(REQUIRED_CLASSES).flat());

/** @param {string} elementClass */
export function isAuditClass(elementClass) {
  return CLASS_SET.has(elementClass);
}

/**
 * @param {string} template
 * @param {string} elementClass
 */
export function classFitsTemplate(template, elementClass) {
  const list = REQUIRED_CLASSES[template];
  return Array.isArray(list) && list.includes(elementClass);
}
