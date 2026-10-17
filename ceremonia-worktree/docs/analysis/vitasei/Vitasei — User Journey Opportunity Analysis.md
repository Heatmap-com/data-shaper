**HEATMAP · User Journey Opportunity Analysis**

Vitasei · vitasei.com.co
Prepared 13 October 2026 | Data window 13 September – 12 October 2026
Site behaviour and shopper-journey analysis · 30 days of tracked visits

---

**Vitasei**

**User Journey Opportunity Analysis**

PREPARED 13 OCTOBER 2026 · DATA WINDOW 13 SEPTEMBER – 12 OCTOBER 2026

This report follows how shoppers move through vitasei.com.co. The order table has no rows, so there is no order rate and no revenue per visit to rank. The path is read on add-to-cart and checkout. Human visits are 53,286. Dead sessions are 49,875 of 103,161 raw visits (48.3%). 4,207 visits added to cart. 47 reached checkout.

> **How to read a journey.** A journey is the sequence of page classes in a visit. Consecutive repeats of a class count once. On this site the stored classes are `other` and `cart`. Homepage, collection, and product URLs were not tagged as their own class: `saw_home`, `saw_product`, `saw_collection`, and `n_prod` are zero on every human visit. A quick-add can fire from one tracked page, so one class is not "no cart".

# Contents

| 01 The Month in Journeys | 02 The Journeys That Reach a Cart |
|----|----|
| 03 Where the Journeys Leak | 04 How the Period Reshaped the Funnel |
| 05 Returning Visitors | 06 Behaviour Signals Worth Watching |
| 07 Where the Journey Data Points | A Data and Method |

# 01 The Month in Journeys

There are no orders and no revenue in the order file. The month is 53,286 human visits, 4,207 add-to-cart visits (7.9%), and 47 checkout visits (1.1% of the carts).

| **Measure** | **Value** | **Reading** |
|----|----|----|
| Orders / revenue | 0 / $0 | The order table has no rows for this site in 2026 |
| Most common journey | `other` only | 51,527 visits (97%), 3,304 carts (6.4%), 43 checkouts |
| Visits that open the cart | `other → cart` and `other → cart → other` | 951 visits, 742 carts, 3 checkouts |
| Saw the cart page | `saw_cart = 1` | 1,298 visits, 825 carts, 4 checkouts |
| Second product | Not measured | `n_prod` is 0 on every visit |
| Search as a class | `search` only | 52 visits. Too small to rank |

Table 1 — Human visits. Cart means an add-to-cart visit. Checkout means a checkout visit.

The weekly revenue chart is omitted. There is no order revenue to plot.

# 02 The Journeys That Reach a Cart

| **Journey** | **Visits** | **Add to cart** | **Cart rate** | **Checkouts** |
|----|---:|---:|---:|---:|
| other only | 51,527 | 3,304 | 6.4% | 43 |
| other → cart | 479 | 355 | 74% | 1 |
| other → cart → other | 472 | 387 | 82% | 2 |
| other → search → other | 237 | 78 | 33% | 1 |

Table 2 — Journeys with at least 200 human visits. Every order column is zero, so it is left out.

- `other` only is 97% of human visits. It holds the homepage and the products, because those URLs were not given their own class. It also holds 43 of the 47 checkouts.

- A visit that opens the cart adds something on about four visits in five. That is the cart working. Three of those 951 visits record a checkout.

- `other → search → other` is 237 visits and a 33% cart rate, between the one-class visit and the cart visit. One checkout.

> **So what.** The second product view is not in this extract. The measure that is here is the visit that already reached the cart. 825 of the 1,298 visits that saw the cart added to it, and 4 reached checkout. The journey dies after the cart is open. That is Opportunity 2 in the Site Opportunity Report.

# 03 Where the Journeys Leak

Entry class, on human visits:

| **Entry class** | **Visits** | **Add to cart** | **Checkouts** |
|----|---:|---:|---:|
| other | 52,820 | 4,132 | 47 |
| cart | 321 | 63 | 0 |
| search | 121 | 11 | 0 |

Table 3 — Every checkout in the journey file starts in `other`. Search and cart as the entry class are small, and neither records a checkout.

The landing-page comparison that can be priced in dollars is not available. Entry sessions by URL would still have a zero order column. The Site Opportunity Report already separates the channels: search holds 15 of the 47 checkouts, Meta paid holds 3, on a higher cart rate. Those are channel counts, not journey classes, and they are not mixed with this table.

> **So what.** There is no revenue upper bound. The count is 4,160 cart visits with no checkout. Moving them is Opportunity 2, and the size waits on the order feed (Opportunity 1).

# 04 How the Period Reshaped the Funnel

The visit rows cover all 30 days. First half is 13–27 September. Second half is 28 September–12 October. There is no order series, and no peak-day revenue to mark.

The shape that holds in both halves is the one in the device table of the Site Opportunity Report: carts are common, checkouts are not. Mobile is 43,773 of the human visits, 3,299 carts, 30 checkouts. Desktop is 5,277 visits, 306 carts, 10 checkouts. Checkout per cart did not become a different event between the halves in a way this extract can separate from the missing order feed. Read the funnel at cart → checkout until orders exist.

# 05 Returning Visitors

Returning human visits add to cart more often than new ones. 10,908 returning visits, 1,216 carts (11.2%), 9 checkouts. 42,378 new visits, 2,991 carts (7.1%), 38 checkouts.

`bought_before` is not used. With zero orders in the order file, a repeat-purchase rate would be a fiction. The returning flag is the measure.

> **So what.** Returning visitors cart more often and still barely check out (9 of 1,216 carts). The gap to close is the checkout, on both new and returning visits.

# 06 Behaviour Signals Worth Watching

The add-click flag (`c_add`) is zero on every visit. The harvest names the control `Agregar al carrito`, and the click flag does not match that word. Add-to-cart in this report is the event, not the click flag.

| **Signal** | **Visits** | **Add to cart** | **Checkouts** |
|----|---:|---:|---:|
| No click | 18,739 | 85 (0.5%) | 3 |
| 11–25 clicks | 4,274 | 1,648 (39%) | 13 |
| 26 or more clicks | 1,148 | 637 (55%) | 7 |
| Saw the cart | 1,298 | 825 (64%) | 4 |

Table 4 — More clicks go with more carts. Checkouts stay in single digits. The 26-click row is large enough to read as a cart rate and thin as a checkout rate.

# 07 Where the Journey Data Points

| **Move** | **Journey evidence** |
|----|----|
| Restore the order feed (Opportunity 1) | Every journey has zero orders. No path can be ranked in revenue. |
| Walk cart to checkout (Opportunity 2) | 1,298 visits saw the cart, 825 added, 4 checked out. `other` only still holds 43 of 47 checkouts. |
| Tag Meta before pausing it (today's plan) | The journey file cannot name a campaign. The channel file can, and it has no orders either. |

Three numbers to track once the order feed returns:

- Checkouts per cart visit, against 47 / 4,207.
- Checkouts on visits that saw the cart, against 4 / 1,298.
- Orders attached to the `other` only journey, which is where 43 of the current checkouts sit.

# A Data and Method

- The window is 13 September through 12 October 2026. Visit rows cover all 30 days.

- Human visits exclude dead sessions. Journey rows are those visits. Revenue per visit is omitted because `udp_conversions` has no rows for this site from 1 January through 12 October 2026.

- `saw_home`, `saw_product`, `saw_collection`, and `n_prod` are zero on every human visit. This report does not estimate a product-page or second-product effect.

- The add-click flag does not match `Agregar al carrito`. Cart rates use the add-to-cart event.

- Channel is last touch where a channel is named. Ad spend is not in the bundle. No dollar gap is stated.
