# Proposed canonical event taxonomy

**Prepared:** 4 October 2026
**Status:** initial proposal for the tag path. Element classes stay the 54 already in `src/domain/taxonomy.js` (`TAXONOMY_VERSION` `2026-10-04.2`). This document binds a closed set of event names to those classes, shaped to the columns that already persist.
**Reads with:** `Tag-Normalization-Implementation-Plan.md`

---

## 1. What this taxonomy is for

A click joined to a named selector says which control was hit. It does not say that an FAQ opened, which item opened, or that a gallery slide was seen without a click. Those facts are events. The event name is the class of behavior. The item is a position within that class. The words on the item ("Warranty") come from the element binding, not from the tag.

The same names are what a later pool would group on. A selector cannot be pooled across themes. `faq.expand` at position 2 can, once the binding says position 2 is the same kind of item.

---

## 2. What a persisted row can hold

Probed 4 October 2026 on `udp_custom_events` and `journey_custom_map` (`docs/probes/2026-10-04-phase-0.md`, decision D-01). Both tables have the same fields. Neither has a properties column. `event_id` is an integer, not a string.

| Column | Role in this taxonomy |
| --- | --- |
| `event_type` | The canonical action. A string from the closed list below. |
| `event_id` | The item's `position_index` within its class on that page. `0` when the class has a single instance. |
| `event_count` | How many times that action happened on that pageview, unless the registry says this action stores a duration here. |
| `idvisit`, `idloghsr`, `idsite`, `idsitehsr` | The join to the session, the pageview, the clicks, and the revenue. |
| `device_type`, `server_date`, `server_time` | Cuts and ordering. |

The label, the selector, and the class are not in the row. The class is implied by `event_type` via the table below. The label and the selector are read from `ae_element_binding` where `element_class` matches and `position_index` equals `event_id`. A row with no current binding is kept and marked unresolved. It is not evidence.

This replaces the earlier idea of writing `faq.expand|warranty` into `event_id`. An integer cannot hold that string, and adding a column would be a pipeline change.

---

## 3. What does not need an event

These classes are decided from the click joined to the binding. Tagging them would duplicate the clickstream.

`hero_cta`, `promo_cta`, `nav_link`, `nav_toggle`, `product_tile`, `collection_tile`, `offer_add_to_cart`, `bundle_product_add`, `bundle_slot`, `bundle_checkout`, `cart_checkout`, `express_checkout`, `cart_drawer_close`, `rewards_link`, `email_subscribe`, `announcement_bar`, `product_price`, `uvp_item`, `reassurance_item`, `breadcrumb`, `policy_link`, `outbound_link`, `proof_badge`, `cart_icon`, `returns_portal_link`, `protection_widget`.

`content_section` is the same for clicks. Section exposure stays on the attention bands already stored. It is not an event in this version.

---

## 4. Event list

`event_id` is the 0-based position of that item among its siblings on the page, unless a row says otherwise. `event_count` means occurrences on the pageview, unless a row says `dwell_ms` or `visible_ms`. A duration action fires once per item per pageview, and the milliseconds go in `event_count`.

An action marked **tag** is new. An action marked **derive** is computed from clicks and mutations the tracker already stores, and is not tagged.

### 4.1 Disclosure

| `event_type` | Class | Why it is not a click |
| --- | --- | --- |
| `faq.expand` | `faq_item` | The open is the behavior. A click on the question is only a proxy, and it misses a row that was expanded by default. |
| `faq.collapse` | `faq_item` | Close is a second state. |
| `faq.visible_ms` | `faq_item` | `event_count` is how long the answer stayed visible, fired once on collapse or unload. |
| `accordion.expand` | `faq_item` role is not used; class stays `faq_item` only for FAQ. Other accordions use this name and class is recorded on the binding as the nearest class (`spec_item`, `comparison_item`, or `content_section`). | Shared expander, item identity is the index. |
| `accordion.collapse` | same as expand | |
| `size_guide.open` | `size_guide` | Open of a guide that is not a navigation click. |
| `spec.expand` | `spec_item` | |
| `comparison.row_expand` | `comparison_item` | |
| `policy.open` | `policy_link` | Used only when the policy opens in place. A policy that navigates is a click, section 3. |

`default_expanded` does not fit beside the index. The concierge emits one `faq.expand` with `event_count` at least 1 at load for a row that is open on arrival, and the normalization marks `at_load` when `server_time` is within the first second of the pageview. That is a proxy, and the dataset says so.

### 4.2 Media

| `event_type` | Class | `event_count` | Note |
| --- | --- | --- | --- |
| `tab.switch` | `tab_control` | occurrences | `event_id` is the destination index. The origin is not stored. |
| `carousel.slide_view` | `carousel_item` | 1 per item per pageview | Deduped by the snippet. |
| `carousel.rotate` | `carousel_control` | occurrences | Auto-advance and a click are not distinguished in this version. |
| `gallery.view` | `gallery_item` | 1 per item per pageview | |
| `gallery.swipe` | `gallery_item` | occurrences | |
| `gallery.zoom` | `gallery_item` | occurrences | |
| `table.hscroll` | `comparison_item` | occurrences | The table as a whole uses `event_id` 0. |

### 4.3 Choice

| `event_type` | Class | Note |
| --- | --- | --- |
| `variant.select` | `variant_option` | `event_id` is the selected option's index. The previous option is not stored. |
| `quantity.change` | `quantity_control` | `event_id` 0. The new quantity is not stored. The event says the control was used. |
| `subscription.toggle` | `subscription_toggle` | `event_id` 0 one-time, 1 subscription. |
| `tier.select` | `variant_option` | Index of the tier. |
| `sort.change` | `sort_control` | Index of the chosen sort. |
| `filter.apply` | `filter_facet` | Index of the facet. The chosen value is not stored. |
| `filter.clear` | `filter_facet` | `event_id` 0. |
| `atc.invalid_selection` | `offer_add_to_cart` | Fired when add-to-cart is used with no variant chosen. `event_id` 0. |

### 4.4 Reviews, menus, popups, video

| `event_type` | Class | Note |
| --- | --- | --- |
| `review.expand` | `review_item` | Index. |
| `review.helpful` | `review_item` | Index. |
| `review.filter` | `review_summary` | Index of the filter chip. Rating and theme text are not stored. |
| `review.theme_chip` | `review_summary` | Index. |
| `review.jump` | `review_summary` | `event_id` 0. |
| `review.distribution_click` | `review_summary` | `event_id` is the star value 1–5. |
| `menu.open` | `nav_toggle` | `event_id` 0 click, 1 hover. Hover-open is the fact a click cannot give. |
| `menu.close` | `nav_toggle` | |
| `submenu.open` | `nav_link` | Index of the parent item. |
| `submenu.close` | `nav_link` | |
| `popup.impression` | `popup_control` | `event_id` 0. |
| `popup.dismiss` | `popup_control` | |
| `popup.submit` | `popup_control` | |
| `video.play` | `video_player` | `event_id` 0, or the index when a page has several players. |
| `video.quartile` | `video_player` | `event_id` is 25, 50, 75, or 100. One row per quartile. |

Popup trigger (time, scroll, exit) and offer id do not fit. Impression versus dismiss is the part this version keeps.

### 4.5 Cart, sticky purchase, forms, search

| `event_type` | Class | Note |
| --- | --- | --- |
| `cart.open` | `cart_icon` | The drawer opening. A click on the icon is the weaker proxy. |
| `cart.close` | `cart_drawer_close` | |
| `cart.continue_shopping` | `cart_drawer_close` | `event_id` 1, so it does not collide with close at 0. |
| `cart.empty_view` | — | State, not a class. `event_id` 0. |
| `cart.post_atc_view` | — | State. `event_id` 0. |
| `cart.upsell_impression` | `cart_upsell` | Index of the slot. A click on the slot stays a click. |
| `sticky_atc.exposed` | `sticky_atc` | Once per pageview. |
| `sticky_atc.click` | `sticky_atc` | |
| `scroll.reversal` | — | `event_id` is the 0–1000 scroll position after the reversal. `event_count` is how many reversals on that pageview, capped at 5 by the snippet. |
| `field.focus` | `form_field` | Index. The field value is never sent. |
| `field.blur` | `form_field` | |
| `field.error` | `form_field` | |
| `field.retype` | `form_field` | |
| `form.abandon_last_field` | `form_field` | `event_id` is the last focused field. |
| `coupon.focus` | `coupon_field` | |
| `coupon.apply` | `coupon_field` | `event_id` 0 failure, 1 success. The code is not sent. |
| `search.open` | `search_control` | |
| `search.zero_results` | `search_control` | The query is not sent. |
| `search.refilter` | `filter_facet` | |
| `quick_add.click` | `quick_add` | Index. |
| `oos.view` | `product_tile` | Index of the out-of-stock tile. |
| `notfound.view` | — | Page state. `event_id` 0. |

### 4.6 Attention and hover outside the click

| `event_type` | Class | `event_count` | Note |
| --- | --- | --- | --- |
| `hover.dwell` | the binding's class | `dwell_ms` | Desktop only. Snippet emits once per item per pageview, and only when dwell reaches 300 ms. |
| `element.in_view` | the binding's class | `visible_ms` | Once per named item per pageview. Used for items that are not in the ten-element attention set. |
| `urgency.impression` | `urgency_element` | 1 | The displayed string ("only 3 left") is not stored. The class and role (`stock`, `timer`, `shipping_cutoff`) carry the kind. |
| `bnpl.interact` | `payment_option` | occurrences | Role on the binding is `bnpl`. |
| `rec.impression` | `recommendation_tile` | 1 per slot per pageview | |
| `rec.click` | `recommendation_tile` | occurrences | Kept even though a click exists, so impression and click share an index. |

### 4.7 Derived, not tagged

| `event_type` | How it is produced |
| --- | --- |
| `click.no_response` | A click on a bound element with no later pageview, no custom event, and no mutation on that pageview inside one second. Written by the normalization, not by a tag. |

### 4.8 Not in this version

These stay out until a pixel or a vendor feed exists. They are not given event names here, so a concierge does not invent them on the storefront.

- Offer impression, accept, decline, and line-added, including post-purchase.
- Checkout steps, cost reveal, and checkout extensions.
- Tracking-page blocks, thank-you blocks, and returns-portal steps.
- Identity resolved. A session tag can hold that later. It is not an item event.

`from_index`, raw search text, field values, review body, popup offer id, and cart value are omitted on purpose. They do not fit, and several of them must not be stored.

---

## 5. Rules

- The event list is closed. An `event_type` that is not in section 4 is inventoried and never becomes a finding.
- Item text is the binding's name for that `position_index`. Reordering the FAQ changes which historical index means Warranty. Series are cut at a layout change, the same rule as the rest of the program.
- Two items of the same class on one page must have distinct indexes. The concierge assigns the index from the binding, not from the DOM order on the day of the tag if those differ.
- Nothing in the tag is a customer value, a query, a coupon code, or review text.
- A finding that needs a column this version does not store stays held, with the missing measurement named. It is not filled in from the click.
