import { isElementClass } from './domain/taxonomy.js';

/**
 * Maps the naming bot's harvested NameRows
 * ({name, type, selector, rollup, attention, tags, notes, linkClass}) onto
 * the strategy taxonomy. Conservative on purpose: a class is applied only
 * when the row clearly is the clickable control a visitor clicks; anything
 * uncertain stays unnamed (strategies then read blocked, which is a result,
 * not a failure — NAMING-BEFORE-ANALYSIS.md coverage bar).
 *
 * Signals used, in order: rollup rows are containers and never classed; the
 * page URL is weak context (a bundle builder's add-to-cart rows are bundle
 * rows); first matching rule wins; the taxonomy backstop drops anything a
 * rule gets wrong.
 */

/**
 * @param {Array<object>} rows NameRows
 * @param {{pageUrl?: string}} [opts]
 * @returns {Array<{selector: string, element_class: string, name: string}>}
 */
export function mapNameRows(rows, opts = {}) {
  /** @type {Array<{selector: string, element_class: string, name: string}>} */
  const names = [];
  const seen = new Set();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    // A rollup is a container. The hero banner anchor is the control even when
    // the harvest also marked the banner group as a rollup.
    if (row.rollup && !isHeroBannerControl(row)) continue;
    const selector = String(row.selector ?? '').trim();
    if (!selector || seen.has(selector)) continue;
    const cls = classify(row, opts.pageUrl ?? '');
    if (!cls || !isElementClass(cls)) continue;
    seen.add(selector);
    names.push({ selector, element_class: cls, name: String(row.name ?? '').slice(0, 500) });
  }
  return names;
}

/**
 * @param {{name?: string, selector?: string, linkClass?: string, tags?: string}} row
 * @param {string} pageUrl
 * @returns {string | null}
 */
function classify(row, pageUrl) {
  const name = String(row.name ?? '').toLowerCase();
  const selector = String(row.selector ?? '').toLowerCase();
  const linkClass = String(row.linkClass ?? '').toLowerCase();
  const isLinkish = /(^|[ >])a(:|\.|$)/.test(selector) || selector.endsWith(' a') || linkClass !== '' || name.includes('link');
  const onBundlePage = /bundle/.test(new URL(pageUrl, 'https://placeholder.invalid').pathname.toLowerCase());

  // Bundle builder: page context comes first — an add-to-cart on a bundle
  // builder is a bundle row, not an offer row, unless the row names a price
  // or an offer
  if (onBundlePage) {
    if (name.includes('slot')) return 'bundle_slot';
    if (name.includes('bundle') && name.includes('checkout')) return 'bundle_checkout';
    if ((name.includes('add') || name.includes('tile') || name.includes('product')) && !name.includes('offer') && !name.includes('$')) {
      return 'bundle_product_add';
    }
  }
  if (name.includes('bundle') && (name.includes('add') || name.includes('tile') || name.includes('product'))) {
    return 'bundle_product_add';
  }
  if (name.includes('bundle') && name.includes('slot')) return 'bundle_slot';
  if (name.includes('bundle') && name.includes('checkout')) return 'bundle_checkout';

  // Navigation
  if (
    name.includes('hamburger') ||
    name.includes('navigation menu') ||
    (name.includes('menu') && (name.includes('button') || name.includes('open') || name.includes('close') || name.includes('toggle')))
  ) {
    return 'nav_toggle';
  }
  if (name.includes('menu item') || name.includes('nav item')) return 'nav_link';
  if (name.includes('nav') && (isLinkish || name.includes('item') || name.includes('link'))) return 'nav_link';

  // Product cards and buying. Quick add is a control inside the tile.
  // The name often also says "product tile", and that test would swallow it.
  if (name.includes('quick add') || name.includes('quick-add')) return 'quick_add';
  if (linkClass === 'product' || name.includes('product card') || name.includes('product tile')) return 'product_tile';
  if (name.includes('add to cart') || name.includes('add-to-cart') || name.includes('add to bag') || name.includes('add-to-bag')) {
    return 'offer_add_to_cart';
  }
  if (name.includes('buy now') || (name.includes('buy') && name.includes('button'))) return 'offer_add_to_cart';

  // Cart and checkout
  if (name.includes('shop pay') || name.includes('express checkout') || name.includes('paypal')) return 'express_checkout';
  if (name.includes('checkout')) return 'cart_checkout';
  if (name.includes('cart') && (name.includes('close') || name.includes('dismiss'))) return 'cart_drawer_close';
  if (name.includes('upsell') || name.includes('you may also like') || name.includes('empty cart')) return 'cart_upsell';

  // Navigation context guard: controls inside nav/menu/dropdown structures
  // are navigation, whatever their label says. A "Collection Link" in the
  // header menu is a menu link, not a collection tile; an "FAQ Question"
  // inside a mega-menu disclosure is a toggle, not a page FAQ item. Nav
  // containers (ul, nav, div) are not controls and stay unnamed.
  if (/(^|[ >])(nav|menu|drawer|mega-menu|dropdown|disclosure|summary|details)([ >.:]|$)/.test(selector) || /nav|menu|drawer/i.test(selector)) {
    // terminal tag wins: an <a> inside a button-wrapper/details is a link
    if (/(^|[ >])a(:|\.|\[|$)/.test(selector)) return 'nav_link';
    if (/details|summary|disclosure|button|toggle/i.test(selector)) return 'nav_toggle';
    return null;
  }

  // FAQ: only individually-named questions; a shared accordion stays unnamed
  if (name.includes('faq') && (name.includes('question') || name.includes('?'))) return 'faq_item';

  // Collections
  if (name.includes('learn more') && (selector.includes('tile') || selector.includes('card'))) return 'collection_tile';
  if (/collection (link|tile|card)/.test(name)) return 'collection_tile';

  // Promos, announcement, capture
  if (name.includes('announcement')) return 'announcement_bar';
  if (name.includes('promo') && (name.includes('button') || name.includes('cta') || isLinkish)) return 'promo_cta';
  if (name.includes('email') || name.includes('newsletter') || name.includes('subscribe')) return 'email_subscribe';
  if (name.includes('rewards')) return 'rewards_link';

  // Hero CTA: a name that starts with "hero", or the primary banner control
  // whose harvest name says hero banner / hero button. The picture and the
  // section wrappers are not the control. A "Shop Now" button that is not
  // the banner stays unnamed.
  if (isHeroBannerControl({ name, selector })) return 'hero_cta';
  if (name.startsWith('hero') && (name.includes('shop') || name.includes('cta') || name.includes('button') || name.includes('now'))) {
    return 'hero_cta';
  }

  return null;
}

/**
 * The clickable banner: an anchor or button whose name says it is the hero
 * banner. An image named "Hero image" and a "Section - Hero Banner" wrapper
 * are not this control.
 * @param {{name?: string, selector?: string}} row
 */
function isHeroBannerControl(row) {
  const name = String(row.name ?? '').toLowerCase();
  const selector = String(row.selector ?? '').trim().toLowerCase();
  if (!name.includes('hero') || !(name.includes('button') || name.includes('banner'))) return false;
  return /(?:^|[ >])(a|button)(?:$|[#.:[])/.test(selector);
}

const ADD_TO_CART = /\badd to (cart|bag|basket)\b/i;

/** A call to action, not a nav label such as "Shop" inside "Shop All". */
function isCallToAction(text) {
  const t = text.trim();
  if (t.length > 48) return false;
  if (/^(shop|buy|order|start|subscribe)$/.test(t)) return true;
  if (/\b(get|save)\s+\d+\s*%/.test(t)) return true;
  if (/\bget\b.{0,20}\boff\b/.test(t)) return true;
  return /\b(shop now|buy now|get started|order now|start now|try it|claim yours|explore now)\b/.test(t);
}

/**
 * Class a control that was resolved from a click selector in the live page.
 * The stored selector stays the click's idselector; these signals describe
 * the element that selector points at. Cart context is decided before
 * navigation. A hero call to action is a button or link in the first
 * viewport, not a name that happens to start with "hero".
 *
 * @param {{
 *   selector?: string,
 *   text?: string,
 *   ariaLabel?: string,
 *   tag?: string,
 *   role?: string,
 *   href?: string,
 *   boxTop?: number | null,
 *   viewportHeight?: number | null,
 *   ancestors?: string,
 * }} obs
 * @param {{allowHero?: boolean}} [opts]
 * @returns {string | null}
 */
export function classifyObserved(obs, opts = {}) {
  const allowHero = opts.allowHero !== false;
  const text = `${obs.text ?? ''} ${obs.ariaLabel ?? ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
  const selector = String(obs.selector ?? '').toLowerCase();
  const tag = String(obs.tag ?? '').toLowerCase();
  const role = String(obs.role ?? '').toLowerCase();
  const href = String(obs.href ?? '').toLowerCase();
  const ancestors = String(obs.ancestors ?? '').toLowerCase();
  const context = `${ancestors} ${selector}`;
  const inFooter = /\bfooter\b/.test(context);
  const inCart = /cart-drawer|rebuy-cart|ajaxcart|mini-cart|cart__|drawer--cart/.test(context)
    && !/add-to-cart|addtocart/.test(context);
  const inNav = !inFooter && !inCart && /\b(nav|menu|header)\b/.test(context);
  const isControl = tag === 'a' || tag === 'button' || tag === 'summary' || role === 'button' || role === 'link';
  const inFirstViewport = obs.boxTop != null
    && obs.viewportHeight != null
    && obs.boxTop >= -20
    && obs.boxTop < obs.viewportHeight;

  if (inCart) {
    if (/\b(close|dismiss|continue shopping)\b|^[×✕x]$/.test(text) || /overlay|backdrop/.test(selector)) return 'cart_drawer_close';
    if (/shop pay|paypal|apple pay|google pay|express checkout/.test(text)) return 'express_checkout';
    if (/\bcheckout\b/.test(text)) return 'cart_checkout';
    if (/upsell|you may also/.test(text)) return 'cart_upsell';
    return null;
  }

  if (ADD_TO_CART.test(text) && isControl) return 'offer_add_to_cart';

  if (allowHero && !inFooter && isControl && isCallToAction(text) && inFirstViewport && !/load more|view all/.test(text)) {
    return 'hero_cta';
  }

  if (inNav) {
    if (/\blogo\b/.test(text) || /\blogo\b/.test(selector)) return null;
    if (/load more|pagination|\bnext\b|\bprev\b|\bpage \d/.test(text)) return null;
    if (text === '+' || text === '-' || /\b(qty|quantity)\b/.test(text)) return null;
    if (tag === 'a' || role === 'link') return 'nav_link';
    if (tag === 'button' || tag === 'summary' || /menu|hamburger|toggle/.test(text)) return 'nav_toggle';
    return null;
  }

  if (/\bquick[- ]add\b/.test(text) && isControl) return 'quick_add';
  if (/\/products\//.test(href) && (tag === 'a' || tag === 'img' || tag === 'button')) return 'product_tile';
  if (
    /faq|accordion/.test(context)
    && !/load more|view all/.test(text)
    && (text.endsWith('?') || /^(how|what|why|when|can|do|does|is|will)\b/.test(text))
  ) {
    return 'faq_item';
  }
  if (/email|newsletter|\bsubscribe\b/.test(text) || (tag === 'input' && /email/.test(context))) return 'email_subscribe';
  if (/\/collections\//.test(href) && (tag === 'a' || tag === 'img')) return 'collection_tile';
  if (/\bcheckout\b/.test(text) && isControl) return 'cart_checkout';
  if (/\bannouncement\b/.test(context)) return 'announcement_bar';
  if (/\brewards?\b/.test(text) && isControl) return 'rewards_link';
  return null;
}

/**
 * Classify resolved click controls. At most three hero_cta, the ones highest
 * on the page. A control that loses the hero cap is classified again without
 * the hero rule.
 *
 * @param {Array<object>} observations
 * @returns {Array<{selector: string, element_class: string, name: string}>}
 */
export function assignClickClasses(observations) {
  /** @type {Array<{obs: object, cls: string | null}>} */
  const tagged = [];
  for (const obs of observations) {
    const selector = String(obs?.selector ?? '').trim();
    if (!selector) continue;
    tagged.push({ obs, cls: classifyObserved(obs) });
  }
  const heroes = tagged
    .filter((row) => row.cls === 'hero_cta')
    .sort((a, b) => Number(a.obs.boxTop ?? 0) - Number(b.obs.boxTop ?? 0));
  const keepHero = new Set(heroes.slice(0, 3).map((row) => row.obs.selector));
  /** @type {Array<{selector: string, element_class: string, name: string}>} */
  const names = [];
  const seen = new Set();
  for (const row of tagged) {
    let cls = row.cls;
    if (cls === 'hero_cta' && !keepHero.has(row.obs.selector)) {
      cls = classifyObserved(row.obs, { allowHero: false });
    }
    if (!cls || !isElementClass(cls) || seen.has(row.obs.selector)) continue;
    seen.add(row.obs.selector);
    const label = String(row.obs.text || row.obs.ariaLabel || cls).replace(/\s+/g, ' ').trim().slice(0, 180);
    names.push({ selector: String(row.obs.selector), element_class: cls, name: label });
  }
  return names;
}
