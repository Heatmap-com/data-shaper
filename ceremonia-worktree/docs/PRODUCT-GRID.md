# Product grid methodology

**Date:** 10 October 2026
**Status:** methodology. Not implemented. Rule 15 in `src/adapters/datasets/strategy-triggers.js` is unchanged.
**Page used to fix the geometry:** DVF homepage, idsite `5795`, idsitehsr `51247422`, batch `9bbe0ed1-184c-469a-9f56-cae8426b94c2`, window 2026-09-10 through 2026-10-09.

A product grid is a block of `product_tile` cells. The analysis asks where a cell, a row, or a run of cells behaves differently from what its exposure and its position predict, and what to do next: diagnose the layout, test a move, or watch until the volume exists.

Order rate is the last rung of that question. On the dresses block below, 493 clicking sessions produced 5 orders. A 1.25× ratio between two one-order cells is not a finding. The dense signals are which cells were reachable, which were clicked, and how that split changes between desktop and mobile.

## 1. What rule 15 does today

Strategy P1 is rule 15, `promoteByPosition` on `product_tile`. It ranks classed selectors by orders divided by clicking sessions, and it fires when the leader sits at least 50px below a sibling whose order rate is at most the leader's rate divided by 1.25. The click coordinate is `a_y`. Two selectors need at least 10 clicking sessions each.

On this homepage that test stays below the floor. The classed node is the carousel cell. The clicks land on the image inside the cell, and that image is not classed `product_tile`. The cells that do have boxes also share one `y`, so a vertical gap of 50px cannot separate them.

Rule 15 remains the rule for a vertical list of classed controls until this methodology is implemented. It is the wrong test for a grid. FAQ items (rule 16) and nav links (rule 17) are out of scope here.

## 2. The dresses block, as captured

Both devices place eight dresses in one horizontal carousel. A wrapped 4×2 or 2×2 grid would put C5 under C1. Here C5 is to the right of C4. The sweaters block under it is a second carousel of the same shape, with no orders in any slot. The three collection tiles near y 2959 are `collection_tile`, not this grid.

Desktop capture is 1440px wide. Cells are 314px wide, height 530, top at y 910, left edges 347, 677, 1007, 1337, 1668, 1998, 2328, 2658. About four cells meet the viewport. C5 starts past it.

Mobile cells are 297px wide, one row at y 686, left edges 16, 329, 643, 956, 1270, 1583, 1896, 2210. About one cell meets a 390px viewport.

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

Desktop clicking sessions sum to 164. Mobile sums to 329. Orders sum to 5. A session that clicks two cells is in both rows, so the shares in later sections are shares of cell-clicks, not a partition of sessions.

C4–C7 take 17% of desktop cell-clicks and 43% of mobile cell-clicks. That block moves together. Sana 2, last and past the desktop viewport, takes 23% of desktop cell-clicks and is the only desktop cell with orders. Those two facts are the reason layout class comes before any product conclusion.

## 3. Classify the block before comparing cells

Classification uses the captured boxes, per device. It does not use the click coordinate, and it does not assume a wrap.

### 3.1 Find the blocks

Start from `product_tile` bindings whose render-snapshot element box has a finite `x`, `y`, `w`, and `h`. Split into blocks by the longest shared selector prefix that still contains at least two cells (the carousel or grid container). Two carousels on one page stay two blocks. Dresses and sweaters are two blocks.

Inside a block, on one device:

1. Sort cells by `y`, then `x`.
2. Open a new row when a cell's `y` differs from the current row's median `y` by more than `max(40px, 0.35 × median cell height)`.
3. Sort each row by `x`.
4. Assign slots in reading order: row by row, left to right. C1 is the first cell of the first row.

A row whose length is shorter than the earlier rows is a ragged last row. It stays in the block. It does not change the column count.

### 3.2 Name the layout

Let `rows` be the number of y-clusters and `columns` the maximum cells in any row. Let `capture_w` be the render viewport width for that device (`ae_page_render_current.viewport_w`). Let the row's right edge be the last cell's `x + w`.

| Layout | Test | DVF dresses |
|---|---|---|
| `single_column` | `columns = 1` and `rows ≥ 2` | No |
| `carousel` | `rows = 1`, `columns ≥ 2`, and the row's right edge is past `capture_w` | Yes, both devices |
| `fitted_row` | `rows = 1`, `columns ≥ 2`, and the row's right edge is inside `capture_w` | No |
| `wrapped` | `columns ≥ 2`, `rows ≥ 2`, and each row's first `x` is within half a cell width of the first row's first `x` | No |
| `irregular` | Anything else: staggered origins, overlapping boxes, or a row whose first `x` does not line up | No claim |

`wrapped` covers every multi-column grid the capture actually wraps. A 2×2 is `columns = 2`, `rows = 2`, slots C1 C2 / C3 C4. A 4×2 is `columns = 4`, `rows = 2`, slots C1 C2 C3 C4 / C5 C6 C7 C8. The column count is measured, not taken from a template name.

The same products can be `carousel` on mobile and `wrapped` on desktop. The layout label is stored per device. Cross-device rules join cells by product identity when that key exists, and by slot index until it does (see section 8). Slot index is the wrong join when the two devices reorder products. Until `product_id` exists, a cross-device flag says it was joined on name text.

### 3.3 What "above" means

Reading order is the only order used for "this cell sits after that cell."

- **Single column.** C1 is the top. A later slot is lower on the page. Its vertical reach is its own.
- **Wrapped.** Order is row-major. C5 in a 4-column grid is the first cell of the second row, under C1, and it shares C6–C8's reach. C4 is the end of the first row. C4 and C5 do not share reach. A y-gap inside one row is noise: those cells were given the same row because their tops match.
- **Carousel and fitted row.** Order is left to right. There is one vertical reach for the whole row. A cell is in the captured first screen when its left edge is inside `capture_w` and at least half its width is inside `capture_w`. Cells past that edge are off-screen until the visitor scrolls the row. On the dresses desktop capture that prefix is C1–C4. C4 is only partly inside 1440px (left 1337, width 314). C5–C8 are off-screen.
- **Irregular.** Report the boxes. Do not rank, do not flag promotion, do not compute lift.

The 50px `a_y` test is not used. `a_y` is a point on the clicked descendant. It is not the cell's row.

## 4. How the comparison changes with the layout

Every layout uses the same metrics (section 5) and the same gates (section 6). The prior, the reach, and the test you would run are what change.

### 4.1 Single column

One cell per row, stacked. Typical of a narrow mobile collection when the capture really is one column.

Reach is vertical and different per row. A session reaches a row when the top of the row has entered the viewport:

```
scroll_px = scroll_y_max_relative / 1000 * scroll_height
reached    = scroll_px + viewport_h_px > row.y
```

`scroll_y_max_relative` is 0–1000 for 0–100% of document height. On this homepage the max is 1000, so that scale is confirmed. Tiles do not share a row, so there is no within-row contrast and no column prior.

The positional prior is depth. Sessions that scroll deeper are a more engaged subset, so a raw click rate that rises with depth is partly selection. A deep cell looks strong until its rate is compared with the site's usual rate for that depth band. That comparison is deferred until a baseline exists (section 8). Until then a single-column flag may say "this lower cell was clicked more often per reached session than the cell above it" and must say the baseline correction is not applied.

A dead zone is a run of consecutive rows whose click rate given reach collapses, or a reach drop of at least 15 points between two consecutive rows. The reach split is available from pageviews and the row's `y`. If reach falls and the click rate given reach holds, people are not arriving. If reach holds and the click rate falls, people arrive and pass. Layout work comes before a product test in those rows.

The promotion test moves the product up the column. There is no sideways move.

### 4.2 Wrapped multi-column

`columns ≥ 2` and `rows ≥ 2`, origins aligned. This is the 2×2 and 4×2 case.

Cells in one row share one vertical reach, computed with the formula in section 4.1 from that row's `y`. Reach cannot explain a click gap inside the row. The prior inside the row is column: left to right, with the last column allowed to carry an end-of-row pull that belongs to the slot.

Between rows, reach can drop. A 4×2 whose second row starts below the fold will show C5–C8 with less reach than C1–C4 even when every product is equal. Comparing C8's raw clicks with C1's raw clicks credits the fold to the product. The row's reach has to be in the denominator first.

Reading-order rank is `row * columns + col`. A cell later in that rank can still sit in an earlier row than a cell with a lower rank on the next row. "Buried" means later in reading order, and the flag has to say whether the two cells share a row. A within-row gap is the cleaner comparison, because reach is held constant. A cross-row gap is reported only after reach is applied, and it stays provisional until the depth baseline removes selection.

End of row is its own slot class. In a 4-column grid the end-of-row slots are C4 and C8, not only the last slot of the grid. A product that overperforms only in those columns is a slot candidate, not yet a product candidate. Confirming that requires the same column overperforming on other pages (deferred, section 8).

The promotion test has two designs, run separately. Moving the product into an earlier column of the same row asks whether the product pulls. Rotating a different product into a top-row slot asks whether that slot's attention converts. One test at a time on the block.

### 4.3 Carousel

One row, wider than the capture viewport. Dresses and sweaters on both devices.

Vertical reach is one number for every cell. On a homepage carousel that number is "did the row enter the viewport," and it does not separate C1 from C8. Using it as a per-cell denominator would divide every cell by the same count and change nothing about the comparison.

The exposure prior is horizontal, in the capture's coordinate space:

- **In the captured first screen** when at least half the cell's width lies inside `capture_w`.
- **Off-screen** otherwise.

Desktop dresses: C1–C3 are in the first screen, C4 is partial, C5–C8 are off-screen. Mobile dresses: C1 is in the first screen, C2 onward require a swipe.

Click share that falls on the off-screen side is the expected signature of the carousel. It is an exposure description, not a dead zone and not a weak product. Desktop C4–C7 taking 17% of cell-clicks while the same four products take 43% on mobile matches "desktop shows about four, mobile shows about one and visitors swipe." The action is to confirm the swipe, not to treat C4–C7 as a vertical fold.

A cell that is off-screen in the capture and still takes a large share of clicks is the anomaly the carousel can support. Sana 2 at x 2658 takes 38 of 164 desktop clicking sessions. That is the flag worth a test, after two checks that are not optional:

1. The cell is a second product, not a loop clone of an earlier slide. The stored name "Sana 2" is the namer seeing two Sana labels. It is not a product id. Clone detection is deferred on `product_id` (section 8). Until that key exists, the flag is a hypothesis about the cell, and the writeup says the identity is unconfirmed.
2. The pull is not only a last-slot habit. Last-slot confirmation across pages is deferred. The cross-device pattern is available now: Sana at C3 and Sana 2 at C8 both take a larger desktop click share than their mobile share (2.2× and 2.7×). Two non-adjacent cells with the same label moving the same way is the family pattern. It is suggestive, and it is not identified until the href or handle says they are the same family or the same product.

The promotion test moves the cell into the captured first screen and measures click rate and, once it exists, add-to-cart rate for that slot. Order rate is the guardrail. It is not the primary metric at this volume: detecting a doubling from 1% to 2% at the usual power needs on the order of 2,300 clicking sessions per arm, about nine times this block's desktop clicks.

### 4.4 Fitted row

One row that fits inside `capture_w`. Vertical reach is shared. There is no off-screen prefix. Treat the row as the within-row half of a wrapped grid: column prior, no depth bands, no swipe story. A fitted row of three collection tiles would use this layout. Those tiles are `collection_tile` and stay out of the `product_tile` rules until the same classifier is pointed at that class.

### 4.5 Irregular

Boxes overlap, row origins do not line up, or heights differ enough that the row rule splits one visual row. The dataset still stores the boxes and the reason. No flag fires. The page needs a capture check before any grid rule runs.

### 4.6 Cross-device

Desktop and mobile are the natural experiment: same block, often the same products, different column counts and different first screens. Compare click share, and compare lift once lift exists. A flag needs at least 20 clicking sessions on each side.

| Pattern | Reading | Action |
|---|---|---|
| A run of adjacent slots diverges in the same direction | Layout. On a carousel, check whether the weak side is the off-screen prefix before calling it a dead zone. | Diagnose that viewport's layout |
| One cell diverges | Creative or rendering on one viewport | Compare the cell on both captures |
| A family diverges from non-adjacent slots | Device audience wants that product | Test after identity is confirmed |
| Clicks agree and add-to-cart or orders diverge | The product page on the weak viewport | Deferred until per-cell add-to-cart exists. Orders on this block do not clear the gate |

Mobile carries more of this page's traffic (about 16,183 mobile entry sessions with a viewport, against 5,862 desktop). When a mobile flag and a desktop flag are otherwise equal, the mobile flag ranks first.

## 5. Metrics

Per block, per device, per slot, over the batch window. Weekly values are kept so stability can be checked. Sessions are entry sessions on this page. The bot filter used for a flag is `exclude_confirmed`, the same filter as the other strategy rules. The dresses table in section 2 is the unfiltered entry rollup and is the illustration, not the stored flag input.

### 5.1 Exposure

```
row_reach          = entry sessions whose vertical scroll reached that row's y
                     / entry sessions
reached_sessions   = entry sessions × row_reach
```

For a carousel or a fitted row, every slot in the block shares `row_reach`.

`in_capture` is 1 when at least half the cell lies inside `capture_w`. This is a property of the render, not of each session. Session viewport widths vary (desktop viewport-height median on the entry sessions that reached a measured height was 940px; widths are a separate distribution). A 1280px-wide window does not see the 1440px capture's prefix. Mapping each session's `viewport_w_px` into the capture's x coordinates is deferred. Flags that talk about "off-screen" say "off-screen in the captured layout."

### 5.2 Attention

```
ctr_reach(slot)   = clicking_sessions / reached_sessions
click_share(slot) = clicking_sessions / sum of clicking_sessions in the block
```

`ctr_reach` is the metric when rows have different reach (single column, wrapped). `click_share` is the metric when reach is shared (carousel, fitted row, and any within-row contrast). Dividing a carousel's clicks by a shared reach does not change the ranking.

Clicks roll up to the cell. A click counts when its selector equals the cell's selector or begins with that selector plus `" > "`. Summing `selector-weekly` clicking sessions across weeks double-counts a session that clicks in two weeks, and summing across descendant selectors double-counts a session that hits two images. The rollup is one session per cell per device, from the click facts, entry-filtered. That query is new work. It is not a new warehouse column.

### 5.3 Downstream

```
atc_rate(slot)   = atc_sessions / clicking_sessions
order_rate(slot) = orders / clicking_sessions
```

`orders` is the count of entry sessions that clicked the cell and placed an order. It is not additive across cells. Revenue is the same session's revenue and is also not additive.

`atc_sessions` is deferred. Today `add_to_cart` is a session flag (`saw_atc` in the page-segment stream): the session added something, somewhere. A session that clicks Abigail and Sana 2 and adds one dress cannot be assigned to a slot. Until the join exists, no flag uses an add-to-cart rate, and any downstream sentence says the rung is orders or that downstream is unavailable.

### 5.4 Lift, when a baseline exists

```
expected_clicks = reached_sessions × baseline_ctr(device, column, depth_band)
lift            = clicking_sessions / expected_clicks
```

`baseline_ctr` is the site's own grids over a long window, by device, column index, and depth band. Depth band is required. Deep visitors click more per reached session even when the products are equal, and a baseline that ignores depth will call every deep cell a winner.

There is no baseline in this batch. The batch is one homepage. A regression fitted on the eight dresses cells would absorb the pattern it is meant to detect. Lift flags are deferred. They are not replaced by an eight-point fit labeled as a baseline.

On a carousel the depth band is a single value, so a future carousel baseline is by column and by in-capture versus off-screen, not by vertical depth.

### 5.5 Uncertainty

Rates that are compared use a Beta(1 + k, 1 + n − k) posterior. A comparison reports the probability that one rate exceeds the other, from a posterior draw. A zero is surprising only when the pooled rate predicted enough events to see some (section 6). A rate that fails its gate is stored as insufficient and is left out of the narrative. Ratios of two sub-gate rates are not stored as findings.

## 6. Gates

These are the starting thresholds. They get tightened when flags are later confirmed or refuted. They are not tuned on this one page.

| Signal | Compare two cells | Flag one cell |
|---|---|---|
| Orders | At least 5 orders in the leading cell, and probability-to-beat at least 0.80 | Expected orders at the pooled rate at least 3 |
| Add-to-cart | At least 10 add-to-cart sessions in the leading cell, and probability-to-beat at least 0.80 | At least 50 clicking sessions |
| Reach-normalized clicks, or click share when reach is shared | At least 20 clicking sessions on each cell | At least 20 clicking sessions, and the lift interval excludes 1.0 once lift exists |

Hard rules:

- One order against one order is not comparable. The mobile Koren 1/37 versus Cosette 1/62 contrast clears 1.25× on the arithmetic and fails this gate. It is not a finding.
- Zero orders on a cell is a finding only when the pooled rate predicted at least 3 orders for that cell's click volume. Abigail's 109 clicking sessions across both devices at a roughly 1% pooled rate expect about 1.1 orders. The probability of zero is about 0.33. The zero stays on watch.
- A fixed "20 clicks and no revenue" kill rule is for high-converting controls. A grid near 1% will trip it on ordinary cells. Use the expected-volume test.

The signal rung is chosen by the gate, from orders, down to add-to-cart, down to clicks. The flag names the rung it used.

## 7. Rules

Each rule says which layouts it applies to and whether it can run on the data this engine stores today. **Apply** means the inputs exist once the cell rollup and the classifier exist. **Provisional** means the flag may be computed and must say what correction is missing. **Deferred** means the flag is not emitted.

Stability (R12) and the precision guard (R13) apply to every flag that is emitted.

### R1. Dead zone

A run of two or more adjacent slots, or a whole row, whose attention collapses together. Also a vertical reach drop of at least 15 points between consecutive rows.

| Layout | How it is read | Status |
|---|---|---|
| Single column | Consecutive rows. Split reach-driven from attention-driven with `row_reach` and `ctr_reach`. | Apply, once row reach is computed |
| Wrapped | Same split, at row boundaries. A collapse inside one row is R8, not R1. | Apply for the reach split. The lift form is deferred with the baseline |
| Carousel | A drop on the off-screen prefix is the exposure prior, not a dead zone. R1 fires only when cells inside the captured first screen collapse together. | Apply for that narrower test |
| Fitted row | A collapse across the row, with no reach excuse inside the row. | Apply on click share |

Action when it fires: diagnose. Scroll by row, the capture at that breakpoint, recordings. No product test in a dead zone until exposure is fixed.

### R2. Cross-viewport divergence

`click_share` on one device divided by `click_share` on the other, at least 2.0 or at most 0.5, with at least 20 clicking sessions each side. Lift ratio replaces click-share ratio after the baseline exists.

Classify the flag with the table in section 4.6. On a carousel, a block divergence whose weak slots are the off-screen prefix is labeled exposure, and the action is "confirm the carousel," not "fix a fold."

Status: **apply** on click share, joined by product name text, with the join called out as name text. The lift form and the downstream form are **deferred**.

The dresses desktop-versus-mobile shares that clear 2× on this illustration, before the bot filter: Sana 2.17, Koren 0.38, Nathalie 0.35, Margot 0.44, Sana 2 at 2.73. Koren, Nathalie, and Margot are adjacent and off-screen on desktop, so they are one exposure block, not three product findings. Sana and Sana 2 are the family hypothesis, identity unconfirmed.

### R3. Slot overperformer

Lift at least 1.5, at least 20 clicking sessions, lift interval excludes 1.0, slot not in the prime set. Prime means the top row on a wrapped or single-column grid, and the captured first screen on a carousel.

Before the product is credited, check whether that column or that off-screen last slot overperforms on other pages, and whether the divergence is one device only (R2).

Status: **deferred.** No site baseline, and the last-slot check needs other collection pages. The Sana 2 click-share anomaly is reported under R2, not as a lift.

### R4. Prime-slot leakage

A prime slot with heavy attention and weak downstream. Downstream is an add-to-cart rate below the block median with probability at least 0.80, or an order count whose Poisson probability given the pooled rate is under 0.05.

Status: the order form may be **computed and then left on watch** when expected orders are under 3. It is not emitted as a finding. Abigail in mobile C1 is that watch. The add-to-cart form is **deferred** with per-cell add-to-cart. Emitting R4 as a triggered strategy is deferred.

### R5. Attraction versus conversion

High lift with low downstream is overpromise. Low lift with high downstream is a hidden gem. High and low mean above or below the block median with probability at least 0.80.

Status: **deferred.** Lift needs the baseline. Downstream needs per-cell add-to-cart. Orders on this block do not clear the gate, so an orders-only version would have nothing to say and is not a substitute.

### R6. Sibling contrast

Same `product_family`, lift or click share differs by at least 1.5×, at least 20 clicking sessions each. Or the family over-indexes on one device from non-adjacent slots.

Status: **deferred** until `product_id` and `product_family` are on the cell. Name similarity ("Sana" and "Sana 2") is recorded as an unresolved identity note on the R2 flag. It does not fire R6.

### R7. Reach cliff

Vertical reach falls by at least 15 points between row r and row r+1, or by at least twice the site's usual row-to-row decay.

| Layout | Status |
|---|---|
| Single column, wrapped | **Apply** for the 15-point test, from pageviews and row `y`. The "twice the site's usual decay" form is **deferred** with the baseline |
| Carousel, fitted row | Not applicable. One row has no vertical cliff. A horizontal drop is the carousel prior in section 4.3, not R7 |

### R8. Within-row asymmetry

A column whose click rate given reach stays at least 1.5× from the site's column prior across two or more rows.

Status: the site-prior form is **deferred** with the baseline. A within-row click-share contrast on a wrapped grid or a fitted row, among cells that share reach and clear 20 clicking sessions, is **provisional**: emitted with the label that no column prior was subtracted. A carousel does not use R8 for off-screen cells. It may use the provisional contrast among cells that are all in the captured first screen.

### R9. Recurring positional artifact

A slot whose lift is at least 1.3 on at least 60% of collection pages for that device.

Status: **deferred.** One page in this batch, and lift is deferred.

### R10. Stock

Add-to-cart below the block median and in-stock share under 70%.

Status: **deferred.** No inventory field. Any R4 watch or later R5 flag asks the reader to confirm stock before acting. That sentence is part of the flag text, not a separate rule firing.

### R11. Sort-order mismatch

Spearman correlation between current slot order and lift order, flagged when it is under 0.3 on a block with at least six cells that clear the click gate.

Status: the lift form is **deferred.** A click-share rank correlation is **provisional** on wrapped and single-column blocks, where position and exposure are not the same thing. On a carousel, click-share rank against slot order mostly restates the off-screen prior, so it is not emitted as a sort mismatch.

### R12. Stability

Split the window in half. A flag is stable when it fires in both halves, or the lift (or the click share, for flags that have no lift) stays on the same side of the comparison in both halves. Stable flags may say diagnose or test. An unstable flag drops to watch.

Status: **apply** for every emitted flag. `selector-weekly` is already weekly; the cell rollup has to keep the week so the two halves exist. A flag with no weekly support is watch.

### R13. Precision guard

A rate below its gate is insufficient. It is stored and omitted from the narrative. This is what keeps the one-order mobile ratio out of the writeup.

Status: **apply.**

## 8. Data to add, and the strategies that wait

Three layers. Derived rows are computed from facts the warehouse already has. Added facts are new capture or a new join. Deferred rules stay off until the added fact exists.

### 8.1 Already stored

| Input | Where | Use |
|---|---|---|
| Cell box `x, y, w, h` per device | `render-snapshot` element rows, from `ae_render_node_current` | Layout class, slot, row, column, captured first screen |
| Capture viewport | `ae_page_render_current` | `capture_w`, `capture_h` |
| `product_tile` selector and name | `element-binding` | Which boxes are cells. The name is a label, not an id |
| Clicks with selector, `a_x`, `a_y` | `udp_clicksce_clicks`, already rolled to `selector-weekly` at the clicked node | Source of the cell rollup. `a_y` is not the row |
| Entry session, device, orders, revenue | visits, conversions, the session stream | Denominators and the order rung |
| `scroll_y_max_relative`, `scroll_height`, `viewport_h_px`, `viewport_w_px` | `udp_hsrce_pageviews` | Vertical row reach. Width is stored and not yet mapped into capture x |
| Weekly click grain | `selector-weekly` | Stability, after the rollup keeps week |
| Session add-to-cart flag | custom events `add_to_cart`, on the page-segment stream | Page-level only. Not a slot rate |
| Element dwell for enrolled selectors | `exposure-weekly` from `udp_am_elements` | Not the grid. A carousel cell is not automatically enrolled, and dwell is not horizontal reach |

### 8.2 Derived, no new fact

These are the first implementation. They are a dataset, not a change to rule 15.

| Derived | Rule |
|---|---|
| Block, layout, rows, columns, slot, row, col, `in_capture` | Classifier, section 3 |
| Clicking sessions, orders, revenue per cell, device, and week, descendants rolled up, entry-filtered, `exclude_confirmed` | Every apply rule |
| `row_reach` and `reached_sessions` from pageviews and row `y` | R1, R7, single-column and wrapped `ctr_reach` |
| Click share, and `ctr_reach` where rows differ | R1, R2, provisional R8 and R11 |
| Half-window repeat of those rates | R12 |
| Gate result and rung | R13 |

`collection_tile` can use the same classifier later. It is not in the first dataset. The three-across block near y 2959 is the fitted-row example, and it stays out until `product_tile` is running.

### 8.3 Added facts, and what they unblock

| Fact to add | Why the current model is short | Unblocks |
|---|---|---|
| `product_id` on the cell, from the product href or handle captured with the box | Names collide and clones share a label. "Sana" and "Sana 2" cannot be grouped or separated | R6. Makes the R2 join an identity join. Clone check in section 4.3 |
| `product_family` | Colorways and near-duplicates are the controlled creative comparison | R6 |
| Per-cell add-to-cart: an `add_to_cart` after a click on that cell, carrying the same `product_id` | `saw_atc` is the whole session. Two clicked cells and one add cannot be split | R4 as a finding, R5, the downstream row of R2 |
| Horizontal exposure: `element.in_view` on the cell, or a carousel scroll offset per pageview | Off-screen in the capture is not "the visitor never saw it." Swipe reach is the missing denominator for C5–C8 | Carousel form of R1 that separates "never swiped" from "swiped and skipped." Session-true `ctr_reach` inside a carousel |
| Session viewport mapped into capture coordinates | `viewport_w_px` is on the pageview. The box is in the 1440px (or 390px) capture space. A linear scale is the wrong model for a centered or full-bleed carousel | Replacing "off-screen in the capture" with "off-screen for this session" |
| `baseline_ctr` by device, column, and depth band, from the site's grids over at least 90 days, refreshed on a schedule | This batch is one homepage and 30 days. An in-grid regression is not a baseline | R3, the lift form of R2, R5, R8 against the prior, R9, R11 on lift, the depth-selection correction, the "usual row decay" form of R7 |
| Other collection pages in the batch | `primary-only` kept this run to the homepage. A slot artifact needs many grids | R9, the last-slot check inside R3 |
| `in_stock_share` over the window, plus price and badge as fields | Render has `word_count` and `visual_class`. It does not have price, sale, or stock | R10. Stock sentence on R4 and R5 becomes a measured flag |

Nothing in section 8.3 is invented by the bot and written into a descriptor. These are measured facts. A missing one leaves the rule deferred. It does not produce a low-confidence guess.

### 8.4 Deferred strategies, listed once

| Strategy | Waits on |
|---|---|
| R3 slot overperformer | Baseline, and other pages for the slot-artifact check |
| R4 as a triggered finding | Per-cell add-to-cart, or an order count that clears the expected-volume gate. The order watch may be stored and stays a watch |
| R5 attraction versus conversion | Baseline and per-cell add-to-cart |
| R6 sibling contrast | `product_id` and `product_family` |
| R2 lift ratio, and R2 downstream divergence | Baseline, and per-cell add-to-cart |
| R7 "twice the usual decay" | Baseline |
| R8 against the site column prior | Baseline. The within-row click-share contrast stays provisional and is not this row |
| R9 recurring positional artifact | Baseline and other collection pages |
| R10 stock | Inventory |
| R11 lift-ranked sort | Baseline. Click-share rank on a carousel is not emitted |
| Carousel swipe-versus-skip split | Horizontal exposure |
| Session-accurate off-screen | Viewport mapped into capture x |
| Depth-selection correction on single-column and wrapped grids | Baseline |

Rule 15 is not rewritten to approximate these. A grid page continues to show P1 below the floor or silent until the grid dataset exists and a later change points P1 at it. That change is its own decision, after the dataset has been replayed on this page and the flags match section 2.

## 9. What an emitted flag contains

Impact, confidence, and effort, each 1 to 5. Priority is the sum.

- **Impact.** Reached sessions times the size of the gap. Mobile +1, capped at 5. A prime slot +1, capped at 5.
- **Confidence.** Orders and stable = 5. Add-to-cart and stable = 4. Clicks and stable = 3. Unstable ≤ 2. Provisional (no baseline, or name-text join) loses 1.
- **Effort.** Reorder or swap = 5. New tile image = 3. Layout change = 2.

Action types:

| Action | When |
|---|---|
| Diagnose | R1, an R2 block that is not the carousel's off-screen prefix, R7 |
| Test | A stable R2 cell or family hypothesis whose identity note is clear enough to name the move, later R3, R4, R5, R6, R11 |
| Watch | Failed a gate, failed stability, or is an R4 order watch |

Diagnose flags that would invalidate a test are listed first. A test inside an off-screen prefix, or inside a row the reach cliff says people do not see, is not listed as a test.

The narrative names the rung, the counts ("2 orders of 38 clicking sessions"), the layout, and the action. It states a hypothesis. Sub-gate rates do not appear. On this dresses block the first diagnose item is the desktop off-screen prefix, and the first test hypothesis is Sana 2's desktop click share from x 2658, held until the product id says whether that cell is a second product.

## 10. Application order

This is the order to build. It is not a license to start the build in the same change as this document.

1. **Classifier.** From stored render boxes and `product_tile` bindings, write one row per device per cell: block, layout, slot, row, col, box, `in_capture`. Fixtures: the dresses carousel (one row, eight columns, desktop prefix C1–C3 plus a partial C4), the sweaters carousel (same layout, lower `y`), a synthetic 4×2 with two aligned rows, a synthetic single column, and an irregular stagger that emits no flags. DVF is not re-analyzed as part of the fixture.
2. **Cell rollup.** One entry session, one cell, one device, one week. Descendants count. `exclude_confirmed`. Orders and revenue from the session. Do not sum `selector-weekly` descendant rows.
3. **Row reach.** The section 4.1 predicate over pageviews, joined to the row's `y`. Shared by every cell in the row. Carousel cells therefore share it, and click-share flags do not divide by it.
4. **Emit the apply rules only.** R1 under the layout limits in section 7, R2 on click share, R7's 15-point test, R12, R13. Provisional R8 and provisional R11 only on wrapped, fitted-row, and single-column blocks, labeled provisional.
5. **Replay this page** on the new dataset and read the flags against section 2. The desktop C4–C7 block should come out as carousel exposure. Sana 2 should come out as a cross-device hypothesis with identity unconfirmed. The mobile one-order pairs should be absent from the narrative. P1's rule 15 result should be unchanged.
6. **Add facts from section 8.3 in the order they unblock the most deferred rules:** `product_id`, then per-cell add-to-cart, then horizontal exposure, then the baseline once more than one grid is in the batch. Each addition turns one deferred row in section 8.4 on. It does not turn the others on early.

Experiment readout, when a test is actually run, uses the highest rung that can finish in four weeks. Order rate stays a guardrail. One test per block at a time. A confirmed slot effect updates the baseline. A confirmed product effect does not update the column prior.
