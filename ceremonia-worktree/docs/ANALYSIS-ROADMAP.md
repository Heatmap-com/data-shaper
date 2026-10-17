# DVF analysis roadmap

**Date:** 10 October 2026
**Status:** the checks in the work order are written up in `docs/DVF-OPPORTUNITIES.md`. This file stays the map of what was measured.
**Site:** DVF only. idsite `5795`, homepage `https://dvf.com`, idsitehsr `51247422`, batch `9bbe0ed1-184c-469a-9f56-cae8426b94c2`.
**Window:** 2026-09-10 through 2026-10-09.

Read `ae_dataset_row_current`, `ae_strategy_card_current`, `ae_trend_row_current`, and `ae_trigger_*_current`. The card table is not the start. All 311 cards stopped on the descriptor gate before a trigger was read: LP, PG, PI, and PO are `conditional`, and TD, TG, and TI are `blocked`. The verdicts that exist are the 41 rows of `strategy-triggers`.

## How to read a number

Three windows are easy to mix.

- Page rates in the LP rules use the catalog's 7-day window. With this batch that is the weeks of 28 Sep and 5 Oct. Homepage revenue per session in that cut is **$10.80**, and the order rate is about **1.7%**. The week of 5 Oct is Monday through Friday.
- `page-segment-weekly` itself holds the whole batch. Full weeks are 14 Sep, 21 Sep, and 28 Sep. The week of 7 Sep is the stub at the start. The week of 5 Oct is the stub at the end.
- Selector rules read every week in `selector-weekly`. They are not cut to those two weeks.

A strategy id is a label on a rule. Eighteen ids triggered. They are eight findings. Quote the finding, not the list of ids.

Element revenue and chain revenue are the visit's money. A click does not cause it. A chain total has to be one row per visitor. Homepage rates use the fingerprint bot filter (`exclude_confirmed`). Trend rows use the lighter portal predicate. Trigger chains use neither. Session totals from those three jobs will not match.

## What is already generated

The batch holds the page datasets the LP rules read: `page-segment-weekly`, `entry-by-channel`, `selector-weekly`, `scroll-decile`, `rage-clicks`, `nav-next-page`, `page-country`, `campaign-weekly`, `order-value-hist`, `sister-pages`, plus coverage, funnel, journey, speed, recordings, and the rest of the kept list. Bindings and the render snapshot are on the homepage only. One page is captured.

Three later grains sit beside that:

- **Product grid.** 152 rows. Dresses and sweaters, desktop and mobile, eight cells each, template start 14 Sep. Narrative flags are the dresses exposure run and the two Sana rows. The prior is the other carousel on this page (`same_page_blocks`). Twelve of 32 prior cells clear 20 donor clicks. R3 did not fire.
- **Trend rows.** 8,512 rows, Mondays 14 Sep through 5 Oct, written the night of 10 Oct. Three template paths, three URL paths, five pages, five homepage selectors. One strategy per row, device as a column.
- **Trigger chains.** 61,038 hits and 61,038 chains after the backfill. Closed outcomes run 10 Sep through 25 Sep. 26 Sep through 9 Oct stay open.

## Pass 1 — the strategies that fired

Work these in this order. Each one ends by keeping the finding, narrowing it, or setting it aside.

### 1. Homepage level, before any element

The weekly homepage, all devices, `exclude_confirmed`:

| Week | Sessions | Order rate | Revenue / session | Single-pageview share | Reach 25% |
| --- | --- | --- | --- | --- | --- |
| 7 Sep (stub) | 4,943 | 1.38% | $9.08 | 50.4% | 44.1% |
| 14 Sep | 5,049 | 1.45% | $11.73 | 47.1% | 35.7% |
| 21 Sep | 6,122 | 2.11% | $10.45 | 51.3% | 37.3% |
| 28 Sep | 6,094 | 2.15% | $13.30 | 49.4% | 40.0% |
| 5 Oct (through Friday) | 4,539 | 1.08% | $7.44 | 48.4% | 38.2% |

Single-pageview share stays near half. Reach of the 25% scroll mark stays near 40%. J2 stored 49.4% and went `below_floor` because the 7-day cut emptied the comparison week. On the three full weeks the step is about four points, under the five-point bar. The level is the fact. The step is not.

The week of 5 Oct is the break in the level: order rate 1.08% and $7.44 per session, against 2.15% and $13.30 the week before. Desktop in that cut falls from **$19.74** per session (1,235 sessions, week of 28 Sep) to **$5.62** (1,123 sessions). Mobile moves from **$12.83** (3,751) to **$9.93** (2,511). The stored mobile-to-desktop ratio of **0.90** is those two weeks blended. Rule 9 and H1 stay silent because 0.90 is above 0.40. The week split is the open question.

Scroll rules A1, B1, B6, and J1 stay silent at reach **0.3923**. Hero-fold rules B3 and D3 stay silent at **99.8%** of entry sessions, measured as the CTA's top against viewport height.

### 2. Hero clickers order at 1.12%

B4 and B5. The rule compared hero-clicker order rate **0.0112**, summed across every hero row in the batch, with the page order rate from the 7-day cut. Recompute both rates on the same weeks before calling the hero weak. Then split new and returning. The fold result says the control is on screen. A low order rate among clickers is a different claim from a control visitors cannot see.

### 3. Search entries that out-earn the homepage

A2, A6, and L1. The rule's page revenue per session is the **$10.80** cut. The five search URLs stored above it are Abigail long wrap ($25.56), Irina midi ($48.59), Bianca sequin skirt ($46.00), Nadia ($35.79), and the midi-wrap collection ($13.30). `entry-by-channel` is not cut to the same two weeks. Recompute both sides on one window. Keep a URL only when it is the same kind of entry as the homepage. A product page reached from search is a higher-intent landing than the homepage, and that gap is expected until the windows and the page types match. The collection at $13.30 is the comparison that can survive that check.

### 4. Nav click share of 4.28

E1, direction `e1_strip_nav`. The numerator stacks clicking sessions across nav selectors. The denominator is entry sessions in the 7-day cut. A ratio above 1 is that stacking. Recompute as distinct sessions on one window, then compare the order rate of those sessions with the page. Leave the "strip the nav" reading until that ratio is a share.

### 5. Two menu toggles, 29 times apart, in the week of 7 Sep

B2, D1, E2, F1, and F2. Same class `nav_toggle`, click gap **29.46x**, order gap infinite (one side has orders, the other has none), both sides at or above 10 clicking sessions. The week of 7 Sep is the stub before the template that starts 14 Sep. Name the two selectors. If one is the header menu and the other is a cart-drawer control, this is the class collision P4 also stores, and it is not a broken control.

### 6. 323 selectors with 20 or more clicks and no revenue

D6, E3, and E4. The first rows are chrome: an svg, the highlighted mobile-nav label, a menu back chevron, and two more svgs. Split the 323 into chrome and content. A content row with clicks and no orders is a candidate. A header icon with no revenue is the attribution model. Element revenue is the visit's revenue, so a zero means no clicking session on that selector also ordered.

### 7. The highlighted mobile-nav label converts above the most-clicked label

P3. The highlight parent label (`button:nth-child(5)`, class `parent-label--highlight`) orders at **2.6%** of clicking sessions. The most-clicked parent label (`button:nth-child(2)`) orders at **1.9%**. The bar is 1.25 times. Put the visible words on both nodes before treating this as a menu change. The same highlight node is also in the zero-revenue list, because that list is clicks with visit revenue of zero and this rate is orders per clicking session. Reconcile those two readings on the same rows.

### 8. P4 fired on three classes, and only one pair is a layout question

The stored leader is a cart-drawer button classed `nav_toggle`, order rate **8.6%**, sitting below the mobile header menu button. That pair is the class collision in finding 5. The `nav_link` pair repeats finding 7. The `collection_tile` pair is the one to keep: an image in `div:nth-child(5)` at order rate **1.3%** sits below the old `index-section` heading link. The trend seed still records clicks on that old heading inside this window (494 sessions, 339 of them mobile). Decide whether that heading is still on the current template before ranking the tiles.

### 9. Rage clicks, 31 sessions

H2 and D7. Name the selectors and the device. Thirty-one sessions on a homepage of this volume is a small rate. Keep it only if the sessions sit on one control.

### Set aside unless a later step reopens them

- **P1** `below_floor`. Two `product_tile` selectors never both clear 10 clicking sessions and a click `y`. The cells share a `y`. The grid dataset is the reading of this block. Leave rule 15 as it is.
- **P2** `blocked`. The homepage has no `faq_item`. Footer and nav links that say FAQ are links. Stop.
- **A5, A7** silent. No campaign or country in the rule's set lags on revenue per session.
- **K1, K2, D5** silent. Drawer-close clicks are not several times checkout clicks.
- **F3, F4, F7** silent. The modal order-value bucket is the open **$200+** bucket.
- **C1, C5, G3, G4** silent on the deep-scroll and revenue-per-session test.
- **C7, H1** silent on the blended device ratio. The week split in finding 1 is the device question that remains.

## Pass 2 — the rows behind those findings

Do this after pass 1 has kept or dropped each finding. Stay on the homepage batch.

1. **Week of 5 Oct on the homepage.** Device, referrer, and landing template inside `page-segment-weekly` and `entry-by-channel` for the weeks of 28 Sep and 5 Oct. The question is where the desktop drop from $19.74 to $5.62 sits. Hold the cause. The trend table has the same week on the path `plp > pdp`.
2. **Hero, same weeks.** `selector-weekly` rows classed `hero_cta`, order rate by week next to the page order rate for that week. Then new against returning if the row can be split. The fold measurement stays as stored.
3. **Search sisters, same weeks.** `entry-by-channel` for the homepage and for the five stored URLs, restricted to search, one week at a time. Rank only URLs whose template matches the homepage, and report the product URLs as a separate list of where search revenue lands.
4. **Nav as distinct sessions.** `nav-next-page` joined so a session that clicks two items counts once. Order rate of those sessions against the page, same weeks.
5. **The two `nav_toggle` selectors.** Names, devices, and weeks from `selector-weekly` and the binding. Mark any cart-drawer selector as chrome.
6. **Zero-revenue list, content only.** Drop header, drawer, svg, and consent. What remains is the candidate list, with clicking sessions and orders.
7. **Nav labels.** The visible text of the highlight label and the most-clicked label. One table of clicks, clicking sessions, orders, and visit revenue for those two selectors, by week.
8. **Collection tile against the old heading.** Confirm the heading selector still matches a node on the current template. If it does, compare the section-5 tile and that heading on clicks and orders after 14 Sep. If it does not, the P4 tile pair is the old template and it stops.
9. **Rage selectors.** The 31 sessions by selector and device.

## Pass 3 — what the strategy rules cannot see

These are already stored. Each is a separate write-up. They do not replace a finding in pass 1.

### Dresses carousel

The narrative rows:

- **C4–C7, diagnose.** Off-screen in the captured desktop layout. 17% of desktop cell clicks and 43% of mobile cell clicks, 25 and 138 clicking sessions. The question is swipe exposure. The dresses next-arrow selector agrees on the device split: 143 desktop sessions and 271 clicks, 192 tablet sessions and 376 clicks, **zero mobile**.
- **Sana, watch.** 16% of desktop cell clicks and 7% of mobile, 23 and 23. The name join is unconfirmed. Sana and Sana 2 move together from slots that are not adjacent.
- **Sana 2, test, held.** 26% and 9%, 38 and 28. A product move waits on a product id. C8 may be a cloned slide.

Sweaters do not have a narrative flag. Several sweater slots sit under the 20-session gate. Prime-slot order watches (Abigail, Cosette, Sana, Flavia) are stored and left out of the narrative because expected orders are under 3.

The same-page prior cannot support a lift claim on the dresses anomalies. The donor column for Sana 2 does not clear 20 clicks. A cross-page baseline needs another captured page of the same layout. This roadmap does not capture one.

### Paths and sources

Template rank, all devices, all segments, four Mondays summed: `plp > pdp` is 4,891 sessions and $41,464. `pdp > plp > pdp` is 1,608 sessions and $20,400. `home > plp > pdp > home` is 30 sessions and $18,268.

On `plp > pdp`, Meta is about a fifth of sessions in the weeks of 14 Sep and 21 Sep, then **334 sessions and $381** in the week of 28 Sep (1 buyer), then **89 sessions and $0** in the short week of 5 Oct. Search in the week of 28 Sep is 249 sessions and $3,268. That is the source question to put beside the homepage desktop drop. Do not assign the homepage drop to Meta from these two tables alone.

The URL rank is three whale journeys: Davina, 4 sessions, $17,878; Isobel, 1 session, $13,559; Antonia, 1 session, $12,617. Use them to name the dresses inside the thin home loop. They are not a route ranking.

The five seeded homepage selectors are a device check, not an element ranking. Selector revenue is the visit's revenue. The old `index-section` heading is one of the five and still has 494 sessions in this window.

### Return and purchase after a hit

Closed abandoned-cart days are 10 Sep through 25 Sep: **364 of 3,356** chains purchased (11%) and **1,851** returned (55%). The added revenue on those rows is **$235,354**, and that figure counts a visitor once per cart hit. The one-row-per-visitor figure on the earlier 25 Sep-through-9 Oct purchased set was about $143,000 against $191,740 summed. Use the same reduction on the closed set before quoting dollars.

25 Sep alone is unchanged by the reprocess: 53 of 439 purchased, 257 returned. On that day mobile was 30 of 298, desktop 9 of 75, tablet 14 of 66.

Showed interest is 18% of the 211,515 sessions in the window. On the closed interest chains, later purchase is the rate to read. **845** interested sessions bought before they left, and the chain does not count that purchase. Super-shopper is a visitor-day. Its return rate is high because the definition already requires a prior return.

Open chains from 26 Sep onward move the next time the job runs. Medium is filled on under half of cart hits. Ninety-seven cart hits have a blank visitor id and cannot be followed.

## Pass 4 — ideas, after the passes above

These are not findings. Open one only when the pass that would use it is finished.

- A product id on the tile, so a merchandise swap can be told from a cloned slide. Until then Sana 2 stays held.
- An add-to-cart tag on the button inside the tile, so a cell can be ranked by cart adds. Orders on the cell are too thin for that rank. The tag is an insert into the custom-event table. Clicks on this site in the batch window had no custom-event rows to update.
- A second captured page of the same carousel layout, so the column prior can leave this homepage. One extra page is not yet a site baseline.
- The descriptor gate that left every card unevaluated. Fixing it republishes the pass 1 verdicts. It does not create a new one.
- Crossing two trigger strategies, such as Meta and returning, on one subject. The trend table stores one strategy at a time. Device is already crossed because it is a column.
- A session floor on the URL path rank, so one order stops becoming a path.

## Work order

1. Write the week-of-5-Oct homepage split by device and referrer, next to Meta on `plp > pdp` for the same weeks. No cause.
2. Recompute hero order rate, the five search URLs, and nav reach on one shared window. Keep or drop findings 2, 3, and 4.
3. Name the `nav_toggle` pair, split the 323 zero-revenue selectors, label the P3 nav items, and settle the collection-tile pair against the old heading.
4. Name the rage selectors.
5. Write the dresses carousel from the stored narrative and the next-arrow device row.
6. Write closed-window cart recovery as one row per visitor, by device.
7. Stop. Pass 4 waits on a decision after those six writes.
