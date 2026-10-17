# Product grid analysis

**Date:** 10 October 2026
**Status:** analysis record. The rule catalog lives in `docs/PRODUCT-GRID.md`. This document is the path that produced the four follow-up decisions. It is not the implementation plan. Rule 15 is unchanged.
**Page:** DVF homepage, idsite `5795`, idsitehsr `51247422`, batch `9bbe0ed1-184c-469a-9f56-cae8426b94c2`, window 2026-09-10 through 2026-10-09.

## 1. What started it

Strategy P1 is rule 15, `promoteByPosition` on `product_tile`. It ranks classed selectors by orders divided by clicking sessions. It fires when the leader sits at least 50px below a sibling whose order rate is at most the leader's rate divided by 1.25. The coordinate is `a_y`. Two selectors need at least 10 clicking sessions each.

On this homepage the rule stays below the floor. The classed node is the carousel cell. The clicks land on the image inside the cell. The cells that have boxes share one `y`, so a vertical gap cannot separate them.

The question that replaced the rule was: given a grid whose order counts are too thin to rank products, what can the click and the layout still support? The dresses block is the worked case. `docs/PRODUCT-GRID.md` is the method that came out of it. Four measurements that method needs were not in the warehouse. Those four are the exceptions in sections 4 through 7.

## 2. The dresses block

Both devices place eight dresses in one horizontal carousel. A wrapped 4×2 would put C5 under C1. The capture puts C5 to the right of C4. The sweaters block under it is a second carousel of the same shape, with no orders in any slot. The three collection tiles near y 2959 are `collection_tile` and are a different block.

Desktop capture is 1440px wide. Cells are 314px wide, height 530, top at y 910, left edges 347, 677, 1007, 1337, 1668, 1998, 2328, 2658. About four cells meet that window. C5 starts past it. C4 is only partly inside it.

Mobile cells are 297px wide, one row at y 686, left edges 16, 329, 643, 956, 1270, 1583, 1896, 2210. About one cell meets a 390px window.

Entry-session clicks on anything inside the cell, not bot-filtered:

| Slot | Product | Desktop clicking / orders | Mobile clicking / orders |
|---|---|---|---|
| C1 | Abigail | 33 / 0 | 76 / 0 |
| C2 | Cosette | 40 / 0 | 62 / 1 |
| C3 | Sana | 25 / 0 | 23 / 0 |
| C4 | Koren | 7 / 0 | 37 / 1 |
| C5 | Nathalie | 10 / 0 | 57 / 1 |
| C6 | Margot | 6 / 0 | 28 / 0 |
| C7 | Diane | 5 / 0 | 18 / 0 |
| C8 | Sana 2 | 38 / 2 | 28 / 0 |

Desktop clicking sessions sum to 164. Mobile sums to 329. Orders sum to 5. A session that clicks two cells is counted in both, so a share is a share of cell-clicks.

Two patterns survive the geometry.

**The middle of the desktop row is exposure.** C4–C7 take 17% of desktop cell-clicks and 43% of mobile cell-clicks. The same four products move together. Desktop shows about four cells and the rest sit to the right. Mobile shows about one cell and the rest are a swipe away. Reading that dip as a vertical dead zone, a fold line, or a lazy-load failure points the layout check at the wrong axis.

**Sana 2 is the cell the exposure prior does not explain.** It is last, at x 2658, past the desktop window, and it takes 38 of 164 desktop clicking sessions and both of the desktop orders. A last-slot story does not explain a tile that starts more than a thousand pixels past the viewport. The stored name "Sana 2" is the namer seeing two Sana labels. It is not a product id, so the cell might be a second product or a loop clone of Sana. That identity is unresolved. The same gap applies to every name in the table: "Abigail" is the product in `nth-child(1)` at capture, not an id that traveled with the click. Section 4.5 is that limit.

The order rung does not support a finding. Five orders across 493 clicking sessions is about 1%. Koren on mobile is 1 order of 37 clicking sessions. Cosette is 1 of 62. The ratio clears 1.25× and is one event against one event. It is not comparable. Abigail, the most-exposed mobile slot, has no orders. At a 1% pooled rate her click volume expects about one order, so the zero is not surprising. Detecting a doubling from 1% to 2% needs on the order of 2,300 clicking sessions per arm. Order rate can be a guardrail on a later test. It cannot be the primary metric on this block.

## 3. What the method kept, and what it could not measure

`docs/PRODUCT-GRID.md` classifies a block from the boxes before it compares cells.

| Layout | How it is recognized | What position means |
|---|---|---|
| Single column | One cell per row, rows stacked | Lower on the page. Each row has its own vertical reach |
| Wrapped | Two or more rows, origins aligned. A 2×2 is C1 C2 / C3 C4. A 4×2 is C1–C4 / C5–C8 | Row-major. Cells in one row share vertical reach. The column is the within-row prior |
| Carousel | One row wider than the capture viewport | Left to right. One vertical reach for the whole row. The prior is which cells sit inside the captured window |
| Fitted row | One row that fits in the viewport | Column only |
| Irregular | Staggered or overlapping | No ranking |

Dresses and sweaters are carousels on both devices. The method then separates flags that can run on stored clicks and boxes (cross-device click share, a vertical reach cliff where rows actually differ, the single-order guard, half-window stability) from flags that need a measurement this batch does not have.

Four of those missing measurements are what the rest of this document is about:

1. A site baseline of click rate by device, column, and depth band.
2. Add-to-cart counted on the cell, not on the session.
3. How far a visitor swiped the carousel.
4. Whether a cell that is off-screen in the 1440px capture was off-screen in the visitor's own window.

## 4. Site baseline

### 4.1 The exception

Lift is observed clicks divided by the clicks the cell's position usually produces. The usual rate has to come from the site's own grids, over a long window, split by device, column, and depth band. Depth band is required because people who scroll deeper click more per reached session even when the products are equal.

This batch cannot supply that rate. It is one homepage and 30 days. A regression through the eight dresses cells would absorb the pattern it is meant to detect. Pooling every page's raw clicks is not a substitute: a click cannot be placed in a column or a depth band without the cell's box.

### 4.2 What is already stored

Over the 90 days ending 9 Oct 2026, site 5795 has 2,944,633 clicks across 5,814 pages. Scroll depth and viewport size are on the pageviews. Render boxes and element bindings exist for the homepage only: two device renders, one page.

### 4.3 What was decided

The baseline is part of bringing a site on board, not a query against history. Onboarding captures the collection templates, runs the same layout classifier, rolls clicks up to the cell, and pools click rate by device, layout, column, and depth band. A carousel and a wrapped grid keep separate priors. The page being judged stays out of its own prior.

A pooled cell is used only once it has enough volume to be a prior. Until then a flag that needs the prior stays provisional. The number that counts as enough is not set yet.

The capture is not the only way to find when a template starts. Section 4.4 walks the click stream back to the first day the live template's selectors are present. Days before that day cannot be placed in this template's columns. The same cut happens when a redesign changes the selectors: the old prior stops at the last day the old selectors were the page.

### 4.4 Walking back to the template's first day

Capturing the page fixes the template that is live now: the selectors, the boxes, and which slot is which column. The click stream can then be read backward from that capture. The template is in force on a past day when its key selectors are present and, for a control that does not move, the click still lands inside the band the capture predicts. The first day those selectors are present is the start of this template. Days before that belong to a template the live page no longer shows. A capture taken now cannot reconstruct their columns.

This is conceptually possible, and on this homepage it is already visible. Homepage clicks run from 7 Jul 2026, 139,004 of them. The dresses carousel path `featured-lifestyle` has 2 clicks before 14 Sep 2026 and 2,937 from that day through 9 Oct. Before 14 Sep the main-content clicks sit on `div.shopify-section.index-section` and an overlay header. 14 Sep is the first day of this template. The batch window that opened on 10 Sep contains those two earlier carousel clicks. They do not move the cell rates.

A static control can confirm a span with position. The hero anchor has clicks from 27 Jul, and its weekly median `a_y` stays inside about 300–470 through the current week. The captured banner runs from y 76 to y 886, so those clicks are on the banner. A move that took the median out of that band would end the template even if the selector string survived.

A carousel slide cannot be dated that way. Clicks on desktop `nth-child(1)` of the dresses carousel, inside the current template, have `a_y` spread from 739 to 2389. The captured cell top is y 910 and the cell is 530px tall. Flickity moves the slide, and the image has its own inner slide (`product-item__bg__slide`). `a_y` is where the slide sat when it was clicked. Leaving the captured box is ordinary use, not a new template. Selector presence is the test for this grid. Position is the test for a control that does not move.

14 Sep is the start of the valid window for this homepage template. It is not a site baseline. A baseline still needs other captured grids and a pooled cell with enough volume, and this page stays out of its own prior. Four weeks of one carousel, with a handful of desktop clicks in C4–C7, is the template's own record.

### 4.5 A slot name is not a product, and a swap cannot be recovered

The tile selectors carry no product id. `nth-child(1)` is a position. "Abigail" was read off the live page at capture and written onto that position. If merchandising replaced Abigail with another dress on 20 Sep and the node stayed `nth-child(1)`, every click before the swap and every click after it lands on the same selector, in the same slot, under the same stored name. The cell rate is then a mixture of two products. Nothing in the click, the selector, or a single capture says when the mixture started.

There is no way to capture that after the fact. The earlier page is gone. The click row has no product handle. A later capture shows only whoever occupies the slot now. Walking back to 14 Sep dates the template. It does not date the merchandise inside the slots.

A product id recorded with the click would keep a later swap visible. It cannot be applied backward onto the clicks already stored. Until that id exists, a slot finding is a finding about the position. The product name is the name at capture, and it may not be the product that earned the clicks. Sana and Sana 2 are the same limit: two labels on two positions, with no id to say they are one product, two products, or one product that moved.

## 5. Add-to-cart on the cell, and the custom-event program

### 5.1 The exception

Session add-to-cart exists as a flag: the session fired `add_to_cart` somewhere. A session that clicks Abigail and Sana 2 and adds one dress cannot be assigned to a slot. The grid rules that compare attention with downstream quality wait on a per-cell add.

The first reading was that a typed rollup zone would create the missing fact. A zone marked `product_grid` would be the carousel. A zone marked `product_tile` would be `div:nth-child(N)`. Clicks inside the tile would roll up to the slot. That container is necessary. It is not sufficient. If the tile zone swallows every descendant, the image click and the add click become one number.

### 5.2 What the page actually contains

The add control is already inside the dresses cell. Each slide is `div:nth-child(N)` under `featured-lifestyle-text__carousel-outer`. Inside the image sits a `quick-add-product` button. A second control, the form button in `rs-qv-panel`, is inside the same slide. The harvest named the button "Button - Quick Add Product Tile Grid Best". The mapper tests the words "product tile" before "add to cart", so the button was stored as another `product_tile`. This page has 76 `product_tile` bindings and no `offer_add_to_cart` binding. `rollup_grain` is `selector` on all 258 bindings. `position_index` is −1 on the product rows, so an event that carries an index has nothing to join to.

`udp_custom_events` and `journey_custom_map` have the same shape: `event_type`, integer `event_id`, integer `event_count`, and the visit and pageview ids. Neither has a properties column. Both have zero rows for site 5795 in the window. Nothing records that an add succeeded.

Clicks on the dresses carousel in the window, all visits, not only entry sessions:

| Slot | Image sessions | Quick-add sessions | Quick-view submit sessions |
|---|---|---|---|
| C1 | 140 | 33 | 13 |
| C2 | 127 | 38 | 14 |
| C3 | 78 | 23 | 12 |
| C4 | 58 | 8 | 0 |
| C5 | 84 | 6 | 1 |
| C6 | 44 | 1 | 0 |
| C7 | 33 | 1 | 0 |
| C8 | 147 | 1 | 0 |

Quick-add is used on the visible prefix and almost never on C8, where the image still draws 147 sessions. A quick-add click opens the panel. The form button is the closer proxy for an add, and it is thin. Neither is proof the variant was added. Every one of the 63,339 clicks on this page in the window has click `event_type` 2, so the click stream does not distinguish the add from the image either.

### 5.3 What was decided

Three pieces of work, in this order.

1. **Trend by one segment at a time.** `ae_trend_row` is already one segmentation per row: `segment`, `segment_value`, Monday week, with sessions, orders, revenue, and clicks. A reader picks one strategy. Crossing every tag in one row double-counts the same sessions. The presentation is the same cut: the user chooses the segmentation and sees the weekly trend for those values.
2. **Configure the event on the control.** A person maps the theme's node onto a canonical event. DVF's quick-add is a different node from another theme's add button. The canonical name already in the event list is `quick_add.click`, and `event_id` is the slide index. The words "Abigail" and "Dresses" stay on the binding, looked up from that index. They do not go in the event. `event_id` is an integer.
3. **Present that trend.** Once the event exists, the series is sessions that fired `quick_add.click` at a given index, by week, against those sessions' orders. The view is the segment picker over `ae_trend_row`. It is not a new fact table.

A custom event is not stamped on every click. A click on a named product image is already the click, joined to the binding. A second event that only repeats it would be counted twice. The event is for the behavior the click does not prove. On this page that behavior is the quick-add and the quick-view submit.

The rollup zone still matters, and it is a different job from the event. `product_grid` names the carousel container. `product_tile` names the slide. The quick-add button stays its own class inside the tile so the add rung and the image rung remain separate. The zone type is not designed yet. `position_index` has to be assigned before `event_id` can join.

## 6. Carousel swipe

### 6.1 The exception

Vertical scroll is one number for every dresses cell. It says whether the row entered the window. It does not say whether the visitor swiped to C8. "Off-screen in the 1440px capture" is a property of the render. It is not the share of sessions that reached the slide.

### 6.2 What was decided

No new table and no new click type. The theme's carousel callback emits `carousel.slide_view`, which is already in the event list: once per slide per pageview, `event_id` equal to the slide index. That row is the reach denominator for C5–C8. The same trend view cuts by it.

A swipe is not written as a click. A swipe that never hits a product has no click row, and a synthetic click would inflate the counts the grid rules use. If a percent of the track is needed, it is an integer on that same event family, the way `scroll.reversal` already stores a 0–1000 position in `event_id`. It is not a second system.

The configuration is theme-specific. Flickity on this homepage is not another theme's carousel. The warehouse shape does not change.

## 7. Capture coordinates and slide visibility

### 7.1 The exception

The boxes are measured in one browser window: desktop 1440px wide, mobile about 390px. Desktop C1 starts at x 347 and each cell is 314px wide, so C5 begins at 1668, past that window.

Visitors are not that window. Homepage pageviews in the batch window:

| Device | Width p10 | p50 | p90 | Distinct widths |
|---|---|---|---|---|
| Desktop | 1272 | 1667 | 1920 | 875 |
| Tablet | 820 | 1287 | 1528 | 727 |
| Mobile | 376 | 402 | 440 | 337 |

`viewport_w_px` is the visitor's window. The cell's `x` is the capture's document. Scaling x by `1667 / 1440` does not say which cells were inside the first screen. A wider window may show five cards, or the same four with more margin, and a 1272px window may show three. Card width does not shrink in proportion to the window. Tablet has no capture of its own, so its boxes are not in a 1287px layout at all.

### 7.2 What was decided

For a carousel, the visibility fact is the event in section 6. The snippet raises `carousel.slide_view` when a slide's left edge enters, including on swipe. The row is a custom event on the pageview, joined by `idvisit` and `idloghsr`.

A session tag is the wrong store. `udp_session_tags` is the JSON blob that holds source and medium for the whole visit. Eight slides would collapse into one blob, with no pageview and no index. A name string such as "Carousel Slide Visible-Dresses-Abigail" cannot be pooled across themes, and it does not fit in `event_id`. The event carries the index. The binding carries "Dresses" and "Abigail."

This closes carousel reach. It does not place a wrapped grid's cells into a visitor's window when the grid reflows between 1272px and 1667px. That case is `element.in_view` on the cell: the same custom-event channel, a different name, fired when the cell enters. It is not a coordinate transform of the capture.

## 8. What is settled

- The dresses and sweaters blocks are carousels. A wrapped-grid reading of C5–C8 is the wrong geometry.
- Order rate is the last rung. One order against one order is not a finding. The Koren and Cosette comparison stays out.
- Desktop C4–C7 is the off-screen prefix of a carousel. Sana 2 is the cell that still needs an explanation, and its product identity is unconfirmed.
- The first day of a live template can be found by walking the click stream backward until that template's selectors are present. On this homepage that day is 14 Sep 2026. Selector presence dates a carousel. Position dates a control that does not move. Carousel `a_y` moves during ordinary use and is not the test.
- 14 Sep starts the valid window for this template. It is not a site baseline. The baseline is still an onboarding pool across other captured grids, used when a pooled cell has enough volume. Days before the template's selectors exist stay out of this template's columns.
- A tile with no product id hides a merchandise swap. The selector and the captured name stay the same when the product in the slot changes. That mixture cannot be recovered from clicks already stored.
- Behavior a click does not prove is a custom event: `quick_add.click` for the add control, `carousel.slide_view` for a slide that entered. Names stay on the binding. `event_id` is the index.
- Clicks on named images are not re-emitted as events.
- Trends are one segmentation per row, on the `ae_trend_row` grain, with a view that lets the user pick the segment.
- Swipe configuration is theme JavaScript onto the existing event. It is not a new click type and not a session tag.
- A wrapped grid that reflows uses `element.in_view`, not a rescaling of capture `x`.

## 9. Still open

The next pass is the plan. These are the decisions it still has to make.

- The volume that makes a baseline cell usable, and which templates onboarding captures so the pool is collection grids rather than all 5,814 pages.
- How a theme mapping is written and reviewed: which node, which `event_type`, which index, and who confirms it. This page's quick-add was named as a product tile, and `position_index` is −1, so the mapping has no index to join until that is fixed.
- Whether the rollup zone type (`product_grid`, `product_tile`) is a binding field, and how the add control is kept out of the tile's click rollup.
- Which segment values ship first. The two this analysis earned are `quick_add.click` by slide index and `carousel.slide_view` by slide index.
- Where the segment picker lives, and which weekly metrics it shows.
- When rule 15 starts reading the grid dataset. It stays as it is until that dataset has been checked against the dresses table.
- Whether a future click stores a product id, so a later swap stays visible. The swaps already inside the 14 Sep window cannot be reconstructed either way.
