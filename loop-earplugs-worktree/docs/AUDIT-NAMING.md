# Audit naming matrix

Instructions for the agent working in `cnn-ai-bot`.

You are naming one Heatmap brand for the Roswell site audit. You open six page experiences, assign every required element class, and write one JSON file. The analysis engine loads that file with `--matrix`. It does not read `names.json`, `ae_element_binding`, or `/heatmaps/savenaming` for this audit.

Do the work for one `idsite` at a time. Take `idsite` from the bot catalog or the task. Do not guess it.

## What this file is, and what it is not

The landing-page capture taxonomy (`TAXONOMY_VERSION` `2026-10-04.2`, 54 flat classes such as `hero_cta` and `offer_add_to_cart`) stays where it is. This task does not bump that version, does not call `completeCapture`, and does not write `ae_element_binding`.

This task writes the **audit matrix**: site-level rows, one template at a time, dotted class names such as `pdp.add_to_cart`. The audit joins those rows to click selectors with a regular expression:

```sql
match(log_hsr_event.selector, selector_match)
AND server_date BETWEEN valid_from AND valid_to
AND template = {template}
AND event_type = 2
```

`log_hsr_event.selector` is the CSS selector Heatmap recorded for the click. `selector_match` is a ClickHouse RE2 pattern against that string. A human label is not a selector. A class from the 54-class list is not an audit class.

## The six pages

Open these six experiences on the brand. Global chrome is named while you are on them. It is not a seventh URL.

| Template | What you open | How the engine classifies the URL |
| --- | --- | --- |
| `home` | The homepage, path `/` | path is `/` or empty |
| `plp` | One collection with a normal product grid, and the search results page if search exists | path contains `/collections` or starts with `/collections`. Search stays template `search` unless you add a URL rule |
| `pdp` | One in-stock product page | path contains `/products` (checked before collections, so `/collections/x/products/y` is a PDP) |
| `cart_drawer` | The ajax cart overlay. Add a product, or open the header cart. There is no pageview | not a URL. Measured from drawer clicks |
| `cart_page` | The full cart, path `/cart` | path is `/cart` |
| `checkout` | Checkout, only if it is on the tracked domain | path contains `/checkout` |

If checkout is hosted off the tracked domain, you still emit every `checkout.*` class with `"absent": true`. You do not invent checkout selectors from another site.

If a brand's URLs do not follow those paths, add `urlRules` (below). Do not rename the template to fit the URL.

Name desktop and mobile when the control differs (sticky add-to-cart, hamburger, filter drawer). One `selector_match` may cover both when it is the same node. When mobile uses a different node, emit a second row with the same `element_class` and a `selector_match` that only matches the mobile node. Say which in `element_name` (`Add to cart`, `Add to cart (mobile sticky)`).

## Row shape

The file is one JSON object:

```json
{
  "entries": [],
  "urlRules": [],
  "events": []
}
```

Each object in `entries`:

| Field | Rule |
| --- | --- |
| `idsite` | Positive integer. Same value on every row in the file |
| `template` | One of `home`, `plp`, `pdp`, `cart_drawer`, `cart_page`, `checkout`, `global` |
| `element_class` | A class from that template's list below. The string must match exactly, including the prefix |
| `element_name` | Short human name for reports. Not a class. Not a selector |
| `selector_match` | RE2 pattern. Required when `absent` is false. Empty string when `absent` is true |
| `position` | Integer slot, or `null`. Use it when the same class repeats (hero slide 1, tile 3). `null` when the control is unique or the selector does not encode a slot |
| `valid_from` | `YYYY-MM-DD`. The day you confirmed the selector, or the day a redesign shipped it |
| `valid_to` | `YYYY-MM-DD`, greater than or equal to `valid_from`. Use `2099-12-31` while the selector is still live |
| `absent` | `true` only when you looked and the brand does not have that control. `false` when you have a selector |

`events` is the sale calendar. Leave it `[]` unless the task gives you dates. Do not invent promotions.

`urlRules` is optional. Each rule:

| Field | Rule |
| --- | --- |
| `idsite` | Same site id |
| `template` | An audit template, or `search`, or `unclassified` |
| `pattern` | JavaScript regular expression tested against the URL path (lowercase, query and hash stripped) |

Brand rules are tested before the Shopify defaults. Example, only if this brand's collections are not under `/collections`:

```json
{ "idsite": 123, "template": "plp", "pattern": "^/shop(/|$)" }
```

## Selector rules

`match()` is RE2. These patterns are illegal and will not do what you intend: lookahead, lookbehind, backreferences.

Escape every literal metacharacter in a class, id, or attribute: `. * + ? ^ $ { } ( ) | [ ] \`.

Heatmap often stores a long path. Match the stable tail, not the whole path, so a wrapper change does not break the join. The tail still has to be specific to that control.

```text
recorded:  div#MainContent > div.product-form > button.product-form__submit
pattern:   button\.product-form__submit
```

A bare `.` matches any character. `button.product-form__submit` also matches `buttonXproduct-form__submit`. Escape the dots.

Repeated cards:

- If each card has its own recorded selector with an index (`:nth-child(3)`), emit one row per index you actually saw. Set `position` to that index (1-based unless the DOM index is already 0-based; say which in `element_name` only if it is not 1-based).
- If every card shares one selector with no index, emit one row, `position` null. Do not invent per-card rows the click stream cannot separate.
- Do not emit positions you did not see.

Several selectors for one class are several rows (primary add-to-cart and a second button that is the same control). Do not join them with `|` unless both sides are escaped and you have checked both.

`selector_match` must not contain raw newlines or NUL. Apostrophes are allowed.

An absent row has `"selector_match": ""` and `"absent": true`. An absent row is a finding. Omitting the class is not.

## Coverage bar

Before you finish, every class in the lists below has at least one row for this `idsite` and its template:

- all 12 `home.*` classes
- all 13 `plp.*` classes
- all 23 `pdp.*` classes
- all 14 cart classes on `cart_drawer`, and the same 14 again on `cart_page` (selectors may differ; copy a selector only after you saw the same node)
- all 7 `checkout.*` classes
- all 13 `global.*` classes, with `template` set to `global`

`global.cart_icon` is required three times: on `global`, on `cart_drawer`, and on `cart_page`. Same selector is fine when it is the same header icon.

Count the rows. A file that only names the controls you found, and drops the rest, is incomplete.

## Class catalog

### `home` — homepage

| Class | Name this | Position |
| --- | --- | --- |
| `home.hero_cta` | Primary button or link in the hero | null, unless several heroes |
| `home.hero_slide` | One slide of a rotating hero | slide index |
| `home.hero_carousel_control` | Hero arrows and dots | null, or one row per control |
| `home.category_tile` | Category or collection tile | tile index when the selector has one |
| `home.product_tile` | Product card in a home grid or carousel | tile index when the selector has one |
| `home.product_carousel_control` | Arrows on a product carousel | null |
| `home.promo_banner` | Mid-page promotional banner and its link | null, or one row per banner |
| `home.value_props` | Shipping, returns, guarantee badges | null |
| `home.social_proof` | Reviews, UGC, press logos | null |
| `home.editorial_block` | Story or content module | null |
| `home.inline_email_capture` | Embedded email or SMS form | null |
| `home.quiz_or_finder` | Quiz or product-finder entry | null |

### `plp` — collection and, separately, search tiles

| Class | Name this | Position |
| --- | --- | --- |
| `plp.product_tile_image` | Image link on a product card | tile index when encoded |
| `plp.product_tile_title` | Title link on a product card | same index as the image when both exist |
| `plp.quick_add` | Quick add or quick view on the card | null |
| `plp.swatch` | Color swatch on the card | null |
| `plp.sort_control` | Sort menu and its options | null |
| `plp.filter_open` | Control that opens the filter panel | null |
| `plp.filter_option` | One filter value. Put the filter type in `element_name` (Size, Color, Price) | null |
| `plp.subcategory_link` | Sub-collection pill or link | null |
| `plp.load_more` | Load more or pagination | null |
| `plp.collection_banner` | Banner or in-grid promo tile | null |
| `plp.breadcrumb` | Breadcrumb link | null |
| `plp.wishlist` | Save or heart on the card | null |
| `plp.search_result_tile` | Tile on the search results page, not the collection grid | tile index when encoded |

`plp.filter_option` is one row per filter value you can tell apart, not one row for the whole panel. If every value shares one selector, one row and say so in `element_name`.

### `pdp` — product page

| Class | Name this | Position |
| --- | --- | --- |
| `pdp.gallery_main` | Main image, including mobile swipe on that image | null |
| `pdp.gallery_thumbnail` | Thumbnail | thumbnail index |
| `pdp.gallery_zoom` | Zoom or lightbox control | null |
| `pdp.video` | Product video play | null |
| `pdp.variant_size` | Size option | null, or one row per size if selectors differ |
| `pdp.variant_color` | Color or shade option | null |
| `pdp.size_guide` | Size or fit guide link | null |
| `pdp.quantity` | Quantity selector | null |
| `pdp.add_to_cart` | Primary add-to-cart button | null |
| `pdp.sticky_add_to_cart` | Sticky or floating add-to-cart | null |
| `pdp.express_pay` | Shop Pay, Apple Pay, PayPal on the PDP | one row per button when selectors differ |
| `pdp.subscribe_option` | Subscribe-and-save toggle | null |
| `pdp.bnpl_message` | Pay-later message and its link | null |
| `pdp.price_promo` | Price, compare-at price, promo badge | null |
| `pdp.review_stars` | Star rating near the title | null |
| `pdp.reviews_section` | Review list, filters, pagination, photos | null |
| `pdp.content_tab` | One description tab or accordion. Name it (Ingredients, How to use, Materials) | null |
| `pdp.shipping_returns` | Shipping and returns info | null |
| `pdp.recommendation_tile` | Related or complementary product | tile index when encoded |
| `pdp.bundle_offer` | Bundle or upsell on the PDP | null |
| `pdp.wishlist` | Save or heart | null |
| `pdp.back_in_stock` | Notify-me for an unavailable variant | null |
| `pdp.breadcrumb` | Breadcrumb link | null |

`pdp.add_to_cart` is the main buy button. `pdp.sticky_add_to_cart` is a second node. Do not point both classes at the same selector.

### `cart_drawer` and `cart_page`

Emit the list twice, once with each template. The drawer is the overlay. The cart page is `/cart`.

| Class | Name this |
| --- | --- |
| `global.cart_icon` | Header icon that opens the drawer or navigates to the cart |
| `cart.close` | Drawer close button or overlay. On the cart page, absent if there is no close control |
| `cart.continue_shopping` | Continue shopping link |
| `cart.line_item_link` | Product name or image linking back to the PDP |
| `cart.quantity` | Quantity increase or decrease |
| `cart.remove` | Remove line |
| `cart.upsell_tile` | Recommendation or add-on. Set `position` when indexed |
| `cart.free_shipping_bar` | Free-shipping progress and its link |
| `cart.discount_code` | Discount field and apply button |
| `cart.gift_option` | Gift wrap or gift note |
| `cart.bnpl_message` | Pay-later message in the cart |
| `cart.checkout_button` | Primary checkout button |
| `cart.express_checkout` | Express pay in the cart |
| `cart.view_cart_link` | Drawer link to the full cart page. Absent on `cart_page` if the shopper is already there |

### `checkout`

| Class | Name this |
| --- | --- |
| `checkout.express_pay` | Express pay on checkout |
| `checkout.login` | Login or guest link |
| `checkout.discount_field` | Discount field |
| `checkout.shipping_method` | Shipping method choice |
| `checkout.payment_method` | Payment method choice |
| `checkout.order_summary_toggle` | Order summary expand or collapse |
| `checkout.return_to_cart` | Return to cart |

### `global` — chrome on every template

Collect these from the header, menu, and footer while you are on the six pages. `template` is `global`.

| Class | Name this |
| --- | --- |
| `global.announcement_bar` | Top banner and its links |
| `global.logo` | Logo link |
| `global.nav_item` | One top-level nav item. Put the label in `element_name` |
| `global.nav_menu_link` | A link inside the mega-menu or drawer menu. Put the label in `element_name` |
| `global.mobile_menu_open` | Hamburger |
| `global.search` | Search open and submit |
| `global.account` | Account or login |
| `global.cart_icon` | Header cart |
| `global.popup` | Email or SMS popup. Separate rows for submit and close when they are different nodes (`element_name`: Submit, Close) |
| `global.chat_widget` | Chat or support launcher |
| `global.cookie_banner` | Accept and close |
| `global.locale_selector` | Country or currency selector |
| `global.footer_link` | A footer link. Put the label in `element_name` |

`global.nav_item` and `global.nav_menu_link` are one row per item you can tell apart. A single shared selector with no label in the selector is one row, and `element_name` says the items are not separable.

## Do not map into the 54-class list

If a harvest or an old `names.json` uses the flat classes, translate them. The file you write still uses the dotted class.

| If you see | Write |
| --- | --- |
| `hero_cta` | `home.hero_cta` |
| `collection_tile` | `home.category_tile` or `plp.subcategory_link`, whichever you clicked |
| `product_tile` | `home.product_tile`, `plp.product_tile_image` or `plp.product_tile_title`, or `pdp.recommendation_tile` |
| `offer_add_to_cart` | `pdp.add_to_cart` |
| `sticky_atc` | `pdp.sticky_add_to_cart` |
| `quick_add` | `plp.quick_add` |
| `filter_facet` | `plp.filter_option` |
| `sort_control` | `plp.sort_control` |
| `size_guide` | `pdp.size_guide` |
| `variant_option` | `pdp.variant_size` or `pdp.variant_color` |
| `gallery_item` | `pdp.gallery_main` or `pdp.gallery_thumbnail` |
| `carousel_control` | `home.hero_carousel_control` or `home.product_carousel_control` |
| `cart_checkout` | `cart.checkout_button` |
| `cart_drawer_close` | `cart.close` on template `cart_drawer` |
| `cart_upsell` | `cart.upsell_tile` |
| `express_checkout` | `pdp.express_pay`, `cart.express_checkout`, or `checkout.express_pay` |
| `cart_icon` | `global.cart_icon` |
| `announcement_bar` | `global.announcement_bar` |
| `nav_link` | `global.nav_item` or `global.nav_menu_link` |
| `nav_toggle` | `global.mobile_menu_open` |
| `email_subscribe` | `home.inline_email_capture` or `global.popup` |
| `coupon_field` | `cart.discount_code` or `checkout.discount_field` |
| `breadcrumb` | `plp.breadcrumb` or `pdp.breadcrumb` |

Anything you cannot place in the lists above is not an audit class. Leave it out. Do not add a new `element_class` string. The engine rejects unknown classes.

## Example

```json
{
  "entries": [
    {
      "idsite": 123,
      "template": "pdp",
      "element_class": "pdp.add_to_cart",
      "element_name": "Add to cart",
      "selector_match": "button\\.product-form__submit",
      "position": null,
      "valid_from": "2026-10-06",
      "valid_to": "2099-12-31",
      "absent": false
    },
    {
      "idsite": 123,
      "template": "pdp",
      "element_class": "pdp.sticky_add_to_cart",
      "element_name": "Sticky add to cart",
      "selector_match": "",
      "position": null,
      "valid_from": "2026-10-06",
      "valid_to": "2099-12-31",
      "absent": true
    },
    {
      "idsite": 123,
      "template": "home",
      "element_class": "home.hero_slide",
      "element_name": "Hero slide 1",
      "selector_match": "\\.slideshow__slide:nth-child\\(1\\) a\\.slideshow__link",
      "position": 1,
      "valid_from": "2026-10-06",
      "valid_to": "2099-12-31",
      "absent": false
    }
  ],
  "urlRules": [],
  "events": []
}
```

That example is three rows, not a finished file. A finished file covers every class in the coverage bar.

## Where to write it

Write the file here, replacing `<brand>` with `ceremonia`, `peter-thomas-roth`, `dvf`, `hyperlite`, or `dennys`:

```text
/Users/kennpalm/work/analysis-engine/audit-inputs/<brand>.json
```

The audit run reads that path. It does not query `ae_audit_matrix` today. The table is the same row, if you also insert it:

`journey_events.ae_audit_matrix`, read through `journey_events.ae_audit_matrix_current`.

| JSON field | Column |
| --- | --- |
| `idsite` | `idsite` UInt32 |
| `template` | `template` |
| `element_class` | `element_class` |
| `element_name` | `element_name` |
| `selector_match` | `selector_match` |
| `position` | `position_index` Int32. Write `-1` when JSON `position` is null |
| `valid_from` | `valid_from` Date |
| `valid_to` | `valid_to` Date |
| `absent` | `absent` UInt8, 1 or 0 |

Order key: `(idsite, template, element_class, selector_match)`. A second insert of the same key replaces the row. There is no import command. Do not invent `node src/cli.js --matrix-import`. Hand the file path to:

```bash
node src/cli.js --audit --phase readiness --matrix /Users/kennpalm/work/analysis-engine/audit-inputs/<brand>.json --brands <brand>
```

Readiness query R9 is the check. It counts clicks on the snapshot window whose selector matches a live row. The brand stays partial until that share is at least 80 percent on the templates that have clicks. Absent classes do not count as matches. They keep the class from being silently dropped.

## Procedure

1. Confirm `idsite`, domain, and the six URLs. For the drawer, record the page you opened it from.
2. Harvest the clickable nodes. Use the selector string Heatmap would store, or the selector the naming harvest already stored. Prefer a stable tail.
3. Assign each node to one class in the catalog. One node, one class. The header cart icon is `global.cart_icon`, not also `cart.checkout_button`.
4. Emit a row for every required class. `absent: true` when the control is not on the site.
5. Escape the pattern. Reject a pattern that uses lookahead, lookbehind, or a backreference.
6. Write the JSON file to the path above. Do not write `ae_element_binding`. Do not POST `/heatmaps/savenaming` as a substitute.
7. Stop. The audit engine runs R9. You do not run the 52-week element queries.
