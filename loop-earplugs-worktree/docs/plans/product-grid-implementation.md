# Product grid implementation

**Date:** 10 October 2026
**Status:** plan. Do not start it in the same change as this document.
**Reads with:** `docs/PRODUCT-GRID.md` (method and rule catalog), `docs/PRODUCT-GRID-ANALYSIS.md` (what this homepage actually showed), `~/Downloads/product-grid-anomaly-detection.md` (the anomaly rules this method adopted).

DVF only. idsite `5795`, page `https://dvf.com`, idsitehsr `51247422`, batch `9bbe0ed1-184c-469a-9f56-cae8426b94c2`. Do not analyze another site. Do not bump `TAXONOMY_VERSION`. Do not raise bot-draft confidence. Do not rewrite rule 15 in this plan. Do not edit `IMPLEMENTATION-PLAN.md` or `RUNBOOK.md`.

## What this plan builds

A `product-grid` dataset that classifies each block, rolls descendant clicks up to the cell, and emits the anomaly flags the stored data can support. The dresses carousel is the acceptance case. Flags that need a site baseline, a product id, per-cell add-to-cart, or swipe reach are not emitted. Those inputs are later phases, and each phase turns on only the rules that input unlocks.

The anomaly note's R1–R13 are the catalog. `docs/PRODUCT-GRID.md` section 7 already says which of them can run on a carousel, a wrapped grid, and a single column. This plan does not reopen that split.

## Decisions this plan locks

These were open at the end of the analysis. They are decided here so implementation has one reading.

- **Template start is selector presence, walked backward.** The first day the block's container selector is in the click stream is the first day of this template. On the dresses carousel that day is 14 Sep 2026. Cell metrics start at `max(template start, batch window start)`. Carousel `a_y` is not used to find that day.
- **14 Sep is the window start, not a baseline.** The site baseline stays phase 3. This page is not its own prior.
- **No new rollup-zone column in phase 1.** The block is the longest shared selector prefix of the `product_tile` boxes. A descendant is an image click, a quick-add click, or a quick-view submit by its selector, and those three stay separate counts. A binding field named `product_grid` waits.
- **Product names are capture-time labels.** Every flag that names Abigail or Sana says the name is the product in that slot at capture. A swap inside the window cannot be recovered. Phase 1 does not invent a product id from the name.
- **`quick_add` is already a class.** The mapper returns it when the name contains "quick add", and that test runs before the "product tile" test. No taxonomy bump. Historical clicks are split by selector even when the stored binding still says `product_tile`.
- **Rule 15 stays.** P1 is not pointed at this dataset until a replay has been read against the dresses table and a separate change says so.
- **One segment per trend row**, when trends are built in phase 2. The first two segments are `quick_add.click` by slide index and `carousel.slide_view` by slide index. The segment picker is not part of the analyzer change.

## Phase 1 — the dataset, on data already stored

No tracker change. No theme change. One new fact scan for this page, then the rows are kept.

### 1. Classifier

New module, pure, called from the dataset. Inputs are render-snapshot element boxes and `product_tile` bindings for one device. Output is one record per cell: `block_id`, `layout`, `slot`, `row`, `col`, `x`, `y`, `w`, `h`, `in_capture`, `name`.

The rules are `docs/PRODUCT-GRID.md` section 3. A new row starts when `y` differs from the row median by more than `max(40px, 0.35 × median cell height)`. `in_capture` is 1 when at least half the cell's width lies inside the capture viewport width. Layout is `single_column`, `carousel`, `fitted_row`, `wrapped`, or `irregular`. An irregular block stores the boxes and emits no flags.

`collection_tile` is not an input. The three-across block near y 2959 stays out.

Fixtures, no live ClickHouse:

- Dresses: one row, eight cells, desktop prefix through C3, C4 partial, C5–C8 off-screen. Layout `carousel`.
- Sweaters: the same shape at a lower `y`. A separate block from dresses.
- A 4×2 with aligned origins. Slots C1–C4 / C5–C8. Layout `wrapped`.
- A single column of four. Layout `single_column`.
- Staggered origins. Layout `irregular`, and the flag function returns none.

### 2. Template start

For each block, take the container prefix and find the earliest `server_date` on this `idsite` and `idsitehsr` where a click selector contains that prefix. That date is `template_start`. The dresses prefix `featured-lifestyle` must come back as 2026-09-14. A unit test feeds a fixture of dates. The live check is part of the DVF replay, not of the unit test.

Hero position is not computed in this phase. It was the evidence that a static control can be dated. The grid uses selector presence only.

### 3. Cell rollup

One row per cell, device, and Monday week, from `template_start` through the batch window end.

- Entry sessions only, the same entry definition the click adapter uses.
- Bot filter `exclude_confirmed`.
- A click counts for a cell when its selector equals the cell selector or begins with that selector plus `" > "`.
- Do not sum `selector-weekly`. A session that hits two descendants is one session for that cell.
- Split the session into `image`, `quick_add` (selector contains `quick-add`), and `qv_submit` (selector contains `rs-qv-panel` and `button`). Attention flags use image sessions plus any click that is not quick-add and not the submit. Quick-add and submit are stored and are not the attention numerator.
- Orders and revenue are the session's, and the flag text says they are not additive across cells.
- The product name on the row is the binding's name. The row carries `name_at_capture: true`.

### 4. Row reach

For each row `y`, the share of entry sessions in the clipped window whose pageview satisfies `scroll_y_max_relative / 1000 * scroll_height + viewport_h_px > row.y`. Every cell in the row stores that same share. Carousel flags do not divide by it. Single-column and wrapped flags do, as `ctr_reach`.

### 5. Flags

Implement the rows of `docs/PRODUCT-GRID.md` section 7 whose status is **apply** or **provisional**. Do not implement a deferred row behind a flag that pretends the input exists.

| Rule | Phase 1 behavior |
|---|---|
| R1 | Carousel: fire only when cells inside the captured first screen collapse together. An off-screen run is labeled exposure, action diagnose-the-carousel, and it is not a dead zone. Wrapped and single column: consecutive rows, split reach-driven from attention-driven. No lift threshold. |
| R2 | Click share, ratio ≥ 2 or ≤ 0.5, ≥ 20 clicking sessions on each side. Join desktop to mobile by capture name. The flag says the join is name text. A run of adjacent off-screen slots that diverge together is one exposure flag, not one flag per product. |
| R7 | The 15-point vertical drop, only when the block has two or more rows. Not emitted for a carousel or a fitted row. |
| R8, R11 | Provisional, and only for `wrapped`, `fitted_row`, and `single_column`. The label says no column prior was subtracted. Not emitted for a carousel. |
| R12 | Split the clipped window in half. Stable may say diagnose or test. Unstable is watch. |
| R13 | A rate under its gate is stored as insufficient and omitted from `narrative`. One order against one order is omitted. The mobile Koren and Cosette pair must not appear. |
| R3, R4 as a finding, R5, R6, R9, R10, lift forms of R2 and R11 | Not emitted. R4's order watch may be stored when expected orders are under 3, and the action is watch. Abigail in mobile C1 is that watch if the filtered counts still expect about one order. |

Each flag stores the rung (`clicks`), the counts, the layout, the action (`diagnose`, `test`, or `watch`), and impact, confidence, and effort from `docs/PRODUCT-GRID.md` section 9. Confidence loses 1 when the join is name text. Diagnose flags that would invalidate a test are ordered first.

Narrative sentences are hypotheses. They include the capture-time name caveat in one clause. They do not include a sub-gate ratio.

### 6. Where the rows go

New dataset `product-grid`, scope `page`, adapter `src/adapters/datasets/product-grid.js`, descriptor beside it. Dims carry `device`, `slot`, and `block_id`. Metrics carry the counts, the layout, and the flag fields. A block-level flag has an empty slot.

Register it with dataset discovery the way the other page datasets are registered. Its descriptor declares `"replay": "keep"` once the first collect has written it, so a later replay loads the rows and does not scan clicks again. The first collect is a one-shot against this page, the same shape as the selector-weekly recollect: delete this dataset's rows for the batch and site, then write. It does not claim `ae_site_queue` and does not re-run the full `--run`.

`strategy-triggers.js` is not modified. P1 remains below the floor for this page.

### 7. Mapper

In `src/naming-mapper.js`, a name that contains "quick add" returns `quick_add` before the product-tile test. "Button - Quick Add Product Tile Grid Best" becomes `quick_add`. A name that is only "Abigail Silk Jersey Wrap Dress Product Tile" stays `product_tile`. Tests cover both. Do not re-seed the bot. The stored bindings stay as they are until a later capture. Phase 1's click split does not read the new class. It reads the selector.

### 8. Acceptance on DVF

After the one-shot collect:

- Dresses and sweaters are `carousel` on both devices. Dresses `template_start` is 2026-09-14.
- Desktop C4–C7 come out as one exposure flag, not four product flags and not a vertical dead zone.
- Sana 2 is a cross-device hypothesis with identity unconfirmed and `name_at_capture` set. It is not an R3 lift.
- The narrative has no one-order ratio.
- Rule 15's stored P1 row is unchanged.
- Counts will not match the unfiltered illustration in `docs/PRODUCT-GRID.md` section 2, because this rollup is `exclude_confirmed` and starts 14 Sep. The check is the shape of the flags, not those integers.

## Phase 2 — events the click does not prove

This phase is theme configuration plus a trend write. It does not change the phase 1 flag set until the events exist in the warehouse. DVF's custom-event tables were empty for the batch window, so there is nothing to backfill.

### Binding index

Write `position_index` on the cell bindings for this page, equal to the slot index from phase 1. Today those rows are −1, so an `event_id` cannot join. The quick-add button's binding, once a capture stores it as `quick_add`, gets the same index as its parent cell.

### Theme events

No new table. The theme raises the events already named in `docs/Proposed-Canonical-Event-Taxonomy.md`:

- `quick_add.click` when the quick-add control is used. `event_id` is the slide index. This is the add rung. It is not a copy of the image click.
- `carousel.slide_view` once per slide per pageview, when the slide's left edge enters, including on swipe. `event_id` is the slide index. This is the reach denominator for C5–C8.
- A track percent, if the theme can compute it, is an integer on that same event family. It is not a session tag and not a synthetic click.

The mapping is theme-specific and reviewed by a person: which node, which `event_type`, which index. Flickity on this homepage is the first mapping. Another theme does not inherit it.

### Trends

Write `ae_trend_row` for this page, one segment per row. The first segments are `quick_add.click` by slide index and `carousel.slide_view` by slide index, Monday weeks, with sessions, orders, and revenue. Do not cross the two segments in one row. The view that lets a person pick the segment is specified with that write. It is not built in the phase 1 adapter.

When `carousel.slide_view` has volume, phase 1's carousel exposure flag can be recomputed with swipe reach as the denominator. That recompute is a follow-up collect, not part of the first theme change. Until then the flag keeps the wording "off-screen in the captured layout."

`element.in_view` on a wrapped-grid cell is the same channel and a later mapping. It is how a reflowing grid records visibility. It is not a rescaling of capture `x`. It is not required for the dresses carousel.

### Product id going forward

A click, or the `quick_add.click` event, stores the product handle from the cell's anchor. That keeps a later swap visible. It is not written onto clicks already stored. Phase 1 flags stay labeled `name_at_capture` for the 14 Sep window. Sana versus Sana 2 stays unresolved until a handle exists.

## Phase 3 — site baseline, at onboarding

Not this batch. A site that is brought on board gets its collection templates captured, classified with the phase 1 module, and rolled up the same way. The pool is click rate by device, layout, column, and depth band. A carousel pool and a wrapped pool stay separate. The page being judged is left out of its own prior.

A pooled cell is eligible once it has at least 20 clicking sessions from other pages. That is the click gate from the anomaly note, used as the starting bar. It is not a claim of a power calculation. The bar is revised when later tests confirm or refute flags. Days before a template's `template_start`, and days after a redesign changes its selectors, are excluded from that template's pool.

R3, the lift form of R2, R5, R8 against the prior, R9, and the lift form of R11 turn on only after this pool exists. R6 turns on only after phase 2's product id exists. R4 as a finding and the downstream row of R2 turn on only after `quick_add.click` has volume. R10 stays off until an inventory feed exists. None of these are stubbed in phase 1.

## What this plan does not do

- It does not re-run `--run` for DVF.
- It does not re-seed the naming bot.
- It does not change rule 15, rule 5's 2× gap, or the scroll-decile fold floor.
- It does not treat 14 Sep–9 Oct of this homepage as a baseline for other pages.
- It does not recover which product occupied a slot before the capture.
- It does not emit a flag from a single order.
- It does not put swipe, slide visibility, or quick-add into `udp_session_tags` or into `udp_clicksce_clicks`.
