# DVF × Heatmap — P0 hypothesis brief

**Site:** Diane von Furstenberg, `dvf.com`, Heatmap idsite `5795`, Shopify.
**Source of the hypotheses:** the analyst's sheet `DVFXRosewellXHeatmap - Hypothesis`, copied unchanged as `data/SOURCE_analyst_hypotheses.csv`. The six rows marked **P0** are in scope: serial numbers 1, 4, 8, 9, 10 and 14.
**Data window:** 1–30 September 2026, the analyst's "last month". Weekly tables run into 11 October so the trend after the month is visible.
**Prepared:** 12 October 2026, from the Heatmap warehouse and from the live pages fetched that day.

This file is the input for a report writer. It has six analyst hypotheses, the data that bears on each one, and the reference tables in `data/`. Each claim names its table in the form **[D: file.csv · filter]**.

---

## 0. Instructions for the report writer

You are writing a client-ready CRO hypothesis report for DVF. Use this file and the CSVs in `data/`. Nothing else.

For each of the six P0 hypotheses, in the order below, produce:

1. **Hypothesis title.** Short and specific. The analyst's change, in plain words.
2. **Summary.** The problem, the change, and the expected mechanism, in three or four sentences. Start from the analyst's wording in section 4.x, "The analyst's hypothesis".
3. **What the data shows.** The supporting evidence, then the evidence that cuts against the hypothesis or that the data cannot see. Keep both. A hypothesis report that only lists support is not credible to this client.
4. **Potential impact.** Who is exposed, how much revenue passes through the step, and what moves if the primary metric moves.
5. **Potential financial impact.** Use the scenario rows in `FIN_impact_scenarios.csv`. Present them as scenarios ("if completion rises 5% relative…"), never as forecasts. Show the monthly figure on the September basis and the annual figure on the full-price basis, and say which is which.
6. **ICE analysis.** Score Impact, Confidence and Ease from 1 to 10, give one or two sentences of rationale for each, and report the ICE score as the average of the three. Section 2 has a draft score and rubric for every hypothesis. Keep the draft unless the data in this file supports a different number, and say why if you change one.
7. **Test design.** Primary metric, guardrail metrics, device scope, and whether a four-week test can detect a plausible lift (`TEST_minimum_detectable_effect.csv`).
8. **Data references.** A short source line under each chart or table naming the CSV it came from.

Then add a one-page summary at the front: the six hypotheses ranked by ICE, with the financial range and the single most important fact for each.

Rules:

- **Quote the analyst's baseline as the portal baseline.** Section 3 shows how each one compares with the warehouse. Use the warehouse figures for any comparison inside this pack, because they share one definition. Do not mix the two in one ratio.
- **Correlation is not causation.** Shoppers who open the size guide or tap quantity controls are more engaged to begin with. Their higher or lower add-to-bag rates describe who they are. They do not show what the control does. Say so where it matters.
- **September includes two sale periods.** The full-price days are 8–24 September (`F1_daily_site.csv`, column `period`). Rates move between the two. Section 3 explains why that matters for the baselines.
- **Do not invent benchmarks.** If a number is not in a table here, do not supply one from memory as if it were DVF data. Industry context may be offered only when it is clearly labelled as general context.
- Write for an e-commerce director: plain sentences, numbers anchored to a comparison, one recommendation per hypothesis.

---

## 1. Context the reader needs

**Traffic.** September had 168,926 recorded sessions after the bot filter: 102,982 mobile, 38,948 desktop and 26,996 tablet. There were 2,398 orders and $1,199,954 in revenue. Mobile placed 1,764 of those orders and $854,781 of the revenue. **[D: F2_funnel_by_period_device.csv · period=sep_all] [D: F4_revenue_by_order_device.csv]**

**Price periods.** A day counts as a promotion day when 45% or more of its orders paid less than the item price. On full-price days that share sits at 17–38%.

| Days | Period | What was running |
| --- | --- | --- |
| 1–7 Sep | Sale | End of the late-August sale (Labor Day) |
| 8–24 Sep | Full price | 17 days |
| 25–30 Sep | Sale | The 20%-off checkout offer and Private Sale sends, which continued to 4 Oct |

**[D: F1_daily_site.csv · columns period, promo_day, share_orders_paid_below_item_price]**

**Coverage.** Heatmap records pageviews for about 99% of sessions. Clicks are recorded on 73% of mobile sessions and 35% of desktop sessions. 78% of orders join to a recorded session; the rest are mostly mobile. Rates in this pack are therefore computed inside the recorded sessions, and revenue totals come from all orders.

**What is not tracked.** The Shopify checkout pages, including the Pay Now step, are not recorded on this site. Returns and exchanges are not in the warehouse.

**Device.** The device label comes from the session record (1 desktop, 2 tablet, 3 mobile). Event-table device labels disagree with it and are not used.

---

## 2. ICE — what it is and the draft scores

**ICE** is a prioritisation score used in conversion-rate optimisation and growth teams (Sean Ellis popularised it). Each idea gets three scores from 1 to 10:

| Letter | Question | What raises the score |
| --- | --- | --- |
| **I — Impact** | If the idea works, how much does it move revenue? | A large share of revenue passes the step; the metric is close to purchase; a sizeable share of shoppers meets the problem. |
| **C — Confidence** | How sure are we that the problem is real and that this change fixes it? | Direct behavioural evidence of the problem; consistent signals across devices and periods; no contrary evidence. Lowered by blind spots (for example the untracked checkout) and by data that contradicts the premise. |
| **E — Ease** | How cheap and fast is it to build and test, and to read the result? | A theme or content change, no new data or app, enough traffic to detect a realistic lift in four weeks. |

**ICE score = (I + C + E) / 3.** Some teams multiply instead. The average is used here because it keeps the scale readable.

Draft scores, for the report writer to keep or adjust with a stated reason:

| # | Hypothesis | I | C | E | ICE | The fact that drives the score |
| --- | --- | --- | --- | --- | --- | --- |
| 9 | Model height and size on the second image | 6 | 7 | 9 | **7.3** | The text already exists on 39 of the top 40 PDPs, but only 3.8% of mobile PDP visits open the accordion that holds it |
| 14 | Mobile category quick links above the hero | 5 | 6 | 7 | **6.0** | 48% of mobile homepage visits leave from the homepage; menu openers progress at 70%, others at 30% |
| 10 | Fit recommendation beside the size guide | 6 | 5 | 5 | **5.3** | After opening the size guide, 75% of mobile pageviews end without Add to Bag; fit advice exists on 2 of 40 PDPs |
| 8 | Remove Buy it Now, add a quantity selector | 3 | 4 | 8 | **5.0** | Buy it Now takes 3.6% of mobile purchase-button clicks; 99.2% of orders are a single unit |
| 1 | Reassurance below Pay Now | 7 | 3 | 4 | **4.7** | Every order passes this step, but the step is not tracked, and only 1.9% of checkout starters look at a help page |
| 4 | Cart quantity selector higher | 3 | 2 | 8 | **4.3** | 0.7% of mobile add-to-cart sessions ever tap "plus"; 99.5% of mobile orders are one unit |

---

## 3. The analyst's baselines against the warehouse

The analyst's baselines come from Heatmap portal funnels. The warehouse reproduces some of them closely on **full-price days**, which suggests the portal figures describe normal trading better than the September blend does. September's sale days push cart-to-checkout up and checkout completion down.

| Hypothesis | Analyst metric | Analyst (portal) | Warehouse, all of September | Warehouse, full-price days 8–24 Sep | Reading |
| --- | --- | --- | --- | --- | --- |
| 1 | Mobile checkout completion | 51.64% | 44.1% | 50.0% | Matches full-price days |
| 1 | Mobile CVR | 1.61% | 1.15% | 0.88% | Not reproduced. The portal and the warehouse count sessions differently, and 22% of mobile orders do not join to a recorded session; all mobile orders ÷ recorded mobile sessions is 1.71% |
| 4 | Cart → checkout, all devices | 36.46% | 46.8% | 38.8% | Close to full-price days |
| 4 | Cart → checkout, mobile | 36.01% | 45.6% | 37.7% | Close to full-price days |
| 8, 9, 10 | Add-to-cart rate, Sana black, mobile | 10.59% | 11.3% | — | Close (sessions viewing that product that had an add-to-cart event) |
| 14 | Homepage → collection/PDP, all devices | 24.82% | 41.8% | 42.3% | Not reproduced. The warehouse takes the next page after the first homepage view; the portal funnel step is probably stricter |
| (financial) | AOV, all devices | $560.98 | $500 | $605 | Between the two periods |

**[D: F2_funnel_by_period_device.csv] [D: F4_revenue_by_order_device.csv] [D: PDP_engagement_by_device.csv · scope=dvf-sana-two-dress-in-black, device=mobile, denominator=all_pdp_visits] [D: H14_homepage_progression.csv · population=all_home_visits, device=all]**

---

## 4. The six P0 hypotheses

### 4.1 Hypothesis 1 — Checkout reassurance below Pay Now

**The analyst's hypothesis**

| Field | Value |
| --- | --- |
| Funnel step | Checkout page |
| Observation | Shoppers at the final payment stage may still have unresolved concerns about warranty or money-back guarantee, shipping and delivery, or customer support. That reassurance is not visible near the final purchase action. |
| Change | Add a concise reassurance section immediately below the Pay Now button: warranty or money-back guarantee, shipping and delivery, help and support. |
| Hypothesis | If we add that reassurance below Pay Now, checkout completion rate will improve, because we reduce last-minute risk perception, answer unresolved questions, and increase confidence just before purchase. |
| Primary metric | Checkout completion rate / purchase CVR |
| Baseline (Sep) | Mobile CVR 1.61%, mobile checkout completion 51.64% |
| Secondary | Checkout abandonment, payment-step exits, sales and revenue, time on checkout, support-link interactions |
| Heatmap link | https://portal.heatmap.com/funnels?idSite=5795&selected=206747 |

**What the data shows**

- **About half of checkout starts end without an order.** In September, 44.1% of mobile sessions that started checkout completed it (2,728 starts, 1,203 completed). On full-price days the rate was 50.0%. On sale days it was 41.0%. **[D: F2_funnel_by_period_device.csv · device=mobile]**
- **Completion falls on sale days, not across the board.** Weekly completion for all sessions moved between 44% and 50% through September, and fell to 39% in the week of 5 October. The lowest weeks are the sale weeks and the week after them. **[D: H1_checkout_completion_weekly.csv · scope=all_sessions_event_table]** The earlier DVF report put the September sale drop down to the checkout offer itself: code entry, exclusions, totals that differ from the banner.
- **Abandoners are not gone.** Of 1,011 mobile shoppers who abandoned checkout between 1 and 27 September, 52% returned on the same device within 14 days and 9.8% bought, for $45,063. Desktop abandoners bought later at 17.2%. Counted once per device id. **[D: H1_checkout_abandoner_followup.csv]**
- **Few checkout starters go looking for policy pages.** Only 1.9% of checkout-start sessions viewed a returns, shipping, FAQ or client-services page in the same session. Returns & Exchanges is the most viewed, at 1.35%. Their completion (40.5%, 79 sessions) is close to everyone else's (43.6%). **[D: H1_help_pages_viewed_by_checkout_starters.csv] [D: H1_checkout_starters_by_segment.csv · segment=saw_help_page]**
- **Reassurance already exists earlier in the journey.** Every top PDP shows "Free Shipping and Returns on All Orders" under the buttons. The cart drawer shows "Your order qualifies for free shipping" and "Shipping, taxes, and discount codes are calculated at checkout". **[D: F5_page_facts.csv · page=PDP, Cart drawer]**

**What the data cannot see, or cuts against it**

- The checkout and the Pay Now step are not tracked, so there is no evidence of hesitation at that button: no clicks, no scroll, no time on page. **[D: F5_page_facts.csv · page=Checkout]**
- Low traffic to help pages argues against unresolved policy questions as a large driver. The sale-day drop points to the promotion flow as a bigger lever on completion than reassurance.

**Potential impact.** Every order passes the payment step. Mobile carried $854,781 of September revenue. On full-price trading that is about $715,600 per 30 days. **[D: FIN_impact_scenarios.csv · hypothesis=H1]**

**Potential financial impact** (scenarios, mobile):

| If mobile checkout completion rises by | Monthly gain, Sep basis | Annual gain, full-price basis |
| --- | --- | --- |
| 2% relative | $17,100 | $174,100 |
| 5% relative | $42,700 | $435,400 |
| 10% relative | $85,500 | $870,700 |
| +1 point absolute (44.1% → 45.1%) | $19,400 | — |

Across all devices the 5% scenario is $60,000 a month, or $618,200 a year. **[D: FIN_impact_scenarios.csv]**

**Draft ICE: I 7 · C 3 · E 4 → 4.7.**

- **Impact 7:** all revenue passes the step and half of starts drop out.
- **Confidence 3:** the step is invisible to this data, help-page demand is low, and the clearest completion signal is the sale flow.
- **Ease 4:** adding content below Pay Now needs a Shopify checkout UI extension (Checkout Extensibility, a Shopify Plus feature). Splitting traffic inside Shopify checkout needs a tool that supports checkout. On mobile a four-week test only detects a lift of about 12.5% relative (5.5 points). **[D: TEST_minimum_detectable_effect.csv · hypothesis=H1]**

**Test design notes.**

- Primary metric: checkout completion (orders ÷ checkout starts).
- Guardrails: AOV, discount-code usage.
- Run it on full-price days or stratify by promo day, because a sale changes mobile completion by about 9 points.
- If a split test is not possible in checkout, run it before and after across full-price weeks only.

---

### 4.2 Hypothesis 4 — Move the cart quantity selector higher

**The analyst's hypothesis**

| Field | Value |
| --- | --- |
| Funnel step | Cart |
| Observation | On mobile the quantity selector sits below the checkout pricing, so users must scroll to find it. That makes editing quantity unnecessarily hard at a high-intent stage. |
| Change | Move the quantity selector higher in the cart, directly beside or beneath each product, so quantity can be changed without scrolling. |
| Hypothesis | If the quantity selector is in the immediately visible product area, cart → checkout rate will improve: less searching, less effort, and fewer users abandoning while correcting quantities. |
| Primary metric | Cart → checkout rate |
| Baseline (Sep) | All devices 36.46%, mobile 36.01% |
| Secondary | Quantity-selector interaction rate, cart abandonment, checkout-button CTR, time in cart, scroll depth in cart, quantity changes per cart |
| Heatmap link | https://portal.heatmap.com/funnels?idSite=5795 |

**What the data shows**

- **More than half of add-to-cart sessions do not start checkout.** Mobile cart → checkout was 45.6% in September and 37.7% on full-price days. **[D: F2_funnel_by_period_device.csv]**
- **The drawer is closed more often than it is checked out.** Among mobile add-to-cart sessions with click recording (5,355), 28.0% clicked the drawer's close button and 14.0% clicked its Check Out button. 24.0% reopened the cart from the header. **[D: H4_cart_controls.csv · device=mobile]**
- **Quantity controls are used, almost always to reduce.** 4.3% clicked minus, 0.7% clicked plus, and 0.2% typed in the quantity box. 8.3% clicked "Remove". **[D: H4_cart_controls.csv · device=mobile]**
- **Sessions that touch quantity controls are more engaged, not less.** They started checkout at 55.5%, against 33.7% for sessions that never touched them. That is a difference in who uses the control, not evidence that the control blocks checkout. **[D: H4_quantity_interaction_outcomes.csv · device=mobile]**

**What cuts against it**

- **Multi-unit buying is rare.** 99.5% of mobile orders and 99.2% of all orders have one unit on the recorded line. **[D: H4_units_per_order.csv]** The order-item table keeps one line per order, so multi-item baskets are not itemised. Quantity of the same item above 1 is still a 0.8% case.
- **In the markup the selector already sits in the product area.** Each drawer line item shows image, title, colour, size, price, then the minus/input/plus counter and Remove. Subtotal and Check Out sit in the drawer footer. The pack does not include a rendered mobile screenshot, so the analyst's "below checkout pricing" observation should be confirmed visually before building. **[D: F5_page_facts.csv · page=Cart drawer, Cart page]**
- The data cannot measure scrolling inside the drawer.

**Potential impact.** Every order passes cart → checkout. The exposed revenue is the same as Hypothesis 1. The share of shoppers who need to change quantity is small, so the realistic lift is at the low end of the scenarios.

**Potential financial impact** (mobile):

| If mobile cart → checkout rises by | Monthly gain, Sep basis | Annual gain, full-price basis |
| --- | --- | --- |
| 2% relative | $17,100 | $174,100 |
| 5% relative | $42,700 | $435,400 |
| +1 point absolute (45.6% → 46.6%) | $18,700 | — |

**[D: FIN_impact_scenarios.csv · hypothesis=H4]**

**Draft ICE: I 3 · C 2 · E 8 → 4.3.**

- **Impact 3:** the control matters to under 1 in 100 shoppers who add more than one unit.
- **Confidence 2:** the data contradicts the premise that quantity editing is a common need.
- **Ease 8:** a theme layout change. A four-week mobile test detects about 8% relative. **[D: TEST_minimum_detectable_effect.csv]**

**What the data suggests instead.** The bigger cart signal is the 28% of mobile add-to-cart sessions that close the drawer, set against 14% that click Check Out. A drawer-exit question ("why do shoppers close the bag?") is better supported than quantity placement.

---

### 4.3 Hypothesis 8 — Remove Buy it Now, add a quantity selector beside Add to Bag

**The analyst's hypothesis**

| Field | Value |
| --- | --- |
| Funnel step | PDP |
| Observation | "Buy It Now" has the lowest clicks in the last 30 days, and having two purchase CTAs may split attention. There is no quantity selector beside the primary CTA. |
| Change | Remove "Buy It Now". Keep a single Add to Cart CTA and add a quantity selector beside it. |
| Hypothesis | If we remove the low-engagement Buy It Now and consolidate around Add to Cart with a quantity selector, add-to-cart % will improve: one clear primary action, less decision friction, and shoppers wanting several units can choose quantity before the cart. |
| Primary metric | Add-to-cart rate |
| Baseline (Sep) | Sana black, mobile 10.59% |
| Secondary | CTA click rate, Buy It Now vs ATC click split, quantity >1 rate, cart → checkout, PDP → purchase CVR, revenue per visitor |
| Heatmap link | https://portal.heatmap.com/funnels?idSite=5795&selected=206747 |

**What the data shows**

- **The PDP has two purchase buttons and no visible quantity selector.** "Add to Bag" (with a hidden "Waitlist" button for sold-out sizes) and "Buy it Now", which triggers Shopify's accelerated checkout. Quantity is a hidden field fixed at 1. The same on all 40 top PDPs. **[D: F5_page_facts.csv · page=PDP]**
- **Buy it Now is little used, which confirms the observation.** On mobile in September it took 195 clicks against 5,220 for Add to Bag: 3.6% of the two together. 0.33% of mobile PDP sessions clicked it, against 6.9% for Add to Bag. On Sana black, 1 mobile session in 1,647 clicked it. **[D: H8_purchase_button_clicks.csv] [D: PDP_engagement_by_device.csv · denominator=all_pdp_visits]**
- **The shoppers who do use it are high-intent.** Mobile sessions that clicked only Buy it Now purchased at 26.1% (88 sessions, 23 buyers, $9,035). Sessions that clicked only Add to Bag purchased at 14.6%. Across devices, Buy it Now-only sessions carried $18,054 of September session revenue. **[D: H8_purchase_button_outcomes.csv]**

**What cuts against it**

- Nothing in the data shows that the second button "splits attention". Add-to-bag clicks are on 6.9% of mobile PDP sessions and 12.9% of mobile PDP sessions that clicked anything. There is no comparison page with a single button. **[D: PDP_engagement_by_device.csv]**
- Demand for a quantity selector is very low. 99.2% of orders are one unit. **[D: H4_units_per_order.csv]**
- Removing the button puts its buyers at risk. The 23 mobile Buy it Now buyers a month are a small but high-converting group who chose express checkout.

**Potential impact.** Every PDP session is exposed. The plausible effect is small, because the button being removed is used by 1 PDP session in 300.

**Potential financial impact** (mobile; the same formula applies to H9 and H10):

| If mobile add-to-cart rate rises by | Monthly gain, Sep basis | Annual gain, full-price basis |
| --- | --- | --- |
| 2% relative (12.6% → 12.8%) | $17,100 | $174,100 |
| 5% relative | $42,700 | $435,400 |
| +1 point absolute (12.6% → 13.6%, an 8% relative lift) | $68,000 | — |

These assume cart and checkout rates hold. The downside to watch is the Buy it Now revenue: about $9,000 a month on mobile and $18,000 across devices. **[D: FIN_impact_scenarios.csv · hypothesis=H8] [D: H8_purchase_button_outcomes.csv]**

**Draft ICE: I 3 · C 4 · E 8 → 5.0.**

- **Impact 3:** the removed control is rarely used, and quantity demand is near zero.
- **Confidence 4:** the low-use observation is confirmed; the attention-split mechanism is untested.
- **Ease 8:** a theme change. A four-week mobile test detects about 7% relative on add-to-cart. **[D: TEST_minimum_detectable_effect.csv]**

**Test design notes.**

- Primary metric: add-to-cart rate per PDP session.
- Guardrails: PDP → purchase CVR and revenue per PDP session. The Buy it Now users who convert need protecting.
- Consider testing the button removal without the quantity selector, so the two effects are not confounded.

---

### 4.4 Hypothesis 9 — State the model's height and size on the second image

**The analyst's hypothesis**

| Field | Value |
| --- | --- |
| Funnel step | PDP |
| Observation | Customers may lack enough visual context to judge fit, because the product imagery does not state the model's height or the size worn. |
| Change | Add "Model is X'X'', wearing size X" directly on or below the second product image. |
| Hypothesis | If we show the model's height and size beside the second image, add-to-cart % will improve, because shoppers get a real-world fit reference, can compare with their own body, and feel more confident choosing a size. |
| Primary metric | Add-to-cart rate |
| Baseline (Sep) | Sana black, mobile 10.59% |
| Secondary | Size-guide open rate, size-selection rate, PDP → checkout, PDP conversion, size-related returns |
| Heatmap link | https://portal.heatmap.com/funnels?idSite=5795&selected=206747 |

**What the data shows**

- **The information already exists, but it is hidden.** 39 of the 40 most-viewed PDPs state it, for example "Beatriz is 5'11" and is wearing a size XS" on Sana black. On every page it sits inside the collapsed **Size & Fit** accordion, below Add to Bag, the reassurance line and the Description. It is never on or beside the images. **[D: H9_model_info_inventory.csv] [D: F5_page_facts.csv · element=Model height and size]**
- **Very few shoppers see it.** 3.8% of mobile PDP sessions opened Size & Fit in September, or 7.0% of those that clicked anything. On Sana black it was 1.8%. **[D: PDP_engagement_by_device.csv · share_size_fit_open]**
- **The images get far more attention.** 14.1% of mobile PDP sessions interacted with the gallery (swipe, zoom, lightbox) and 13.5% tapped a colour swatch. **[D: PDP_engagement_by_device.csv · share_gallery, share_color_swatch]**
- **Shoppers who find the sizing information go on to add.** Mobile pageviews where Size & Fit was opened added to bag at 16.7%. Pageviews with the size guide plus Size & Fit added at 30.9%. Pageviews with clicks but no sizing control added at 0.7%. These are engaged shoppers, so the gap reflects intent, not the effect of the content. **[D: H9_H10_sizing_behaviour_vs_add_to_bag.csv · device=mobile]**

**What cuts against it, or is missing**

- **Every model wears size XS.** The line gives a height reference, but a shopper who wears M or L still has to extrapolate. Pairing the line with a fit note (Hypothesis 10) would make it more useful. **[D: H9_model_info_inventory.csv · model_size_worn]**
- Return and exchange reasons are not in the warehouse, so "fewer size-related returns" cannot be baselined here. It needs Shopify or returns-platform data.

**Potential impact.** Every PDP session is exposed. On mobile that is 47,562 recorded PDP sessions in September. The change moves existing text into the place where shoppers already look.

**Potential financial impact.** The same scenario formula as Hypothesis 8. Mobile at 5% relative: $42,700 a month (September basis), $435,400 a year (full-price basis). Each absolute point of mobile add-to-cart is worth about $68,000 a month. **[D: FIN_impact_scenarios.csv · hypothesis=H9]**

**Draft ICE: I 6 · C 7 · E 9 → 7.3.**

- **Impact 6:** sizing is the main uncertainty in dress buying, and all PDP traffic is exposed.
- **Confidence 7:** the visibility gap is measured directly, with 96% of mobile PDP sessions never opening the section. The all-XS models limit how much the line helps.
- **Ease 9:** the content exists in the product data, so this is a template change. A four-week mobile test detects about 7% relative. **[D: TEST_minimum_detectable_effect.csv]**

---

### 4.5 Hypothesis 10 — Fit recommendation beside the size guide

**The analyst's hypothesis**

| Field | Value |
| --- | --- |
| Funnel step | PDP |
| Observation | The size guide gives measurements but still leaves shoppers to interpret which size or fit suits them. |
| Change | Add a contextual fit recommendation beside the size guide, for example "True to size / Fits perfectly / Size down for a closer fit / Size up for an oversized fit". |
| Hypothesis | If we give a clear fit recommendation beside the size guide, add-to-cart % will improve: less ambiguity, less effort interpreting the chart, more confidence in the chosen fit. |
| Primary metric | Add-to-cart rate |
| Baseline (Sep) | Sana black, mobile 10.59% |
| Secondary | Size-guide interaction rate, time from size selection to ATC, size-selector interaction rate, PDP exit after size-guide interaction, PDP CVR, size-related returns |
| Heatmap link | https://portal.heatmap.com/funnels?idSite=5795&selected=206747 |

**What the data shows**

- **The size guide is a chart, and it admits it is only a guide.** The modal shows chest, waist and hips by US size with UK/EU conversions. It says: "Because sizing and cut will vary between styles, please use this chart as a general guide. If you are between sizes or need assistance, please contact Client Services." **[D: F5_page_facts.csv · element=Size guide]**
- **Fit advice is almost absent.** 2 of the 40 top PDPs say "If in between sizes we recommend sizing down". 8 mention fit words ("fitted", "relaxed fit", "fits true to size") in the Description, which few shoppers would read as sizing advice. **[D: H9_model_info_inventory.csv · sizing_advice_present, fit_phrase_in_description] [D: F5_page_facts.csv · element=Fit recommendation]**
- **The size guide is used, and many who open it leave.** 4.9% of mobile PDP sessions opened it. On mobile pageviews where it was opened, 22.9% added to bag afterwards and 74.9% left without adding. Those who added did so a median of 19 seconds after opening it. **[D: PDP_engagement_by_device.csv] [D: H10_size_guide_sequence.csv · device=mobile]**
- **Size tapping without the guide converts better.** Mobile pageviews where the shopper tapped one or two sizes without the guide added to bag at 56.6%, against 24.4% for guide-only pageviews. **[D: H9_H10_sizing_behaviour_vs_add_to_bag.csv · device=mobile]** Shoppers who open the guide are less sure to begin with, and that is the group a fit note is meant to help.
- Sold-out sizes add friction for the same group. 2.8% of mobile size-guide pageviews ended on the Waitlist button. **[D: H10_size_guide_sequence.csv · share_waitlist]**

**What cuts against it, or is missing**

- The 75% who leave without adding include shoppers who were browsing. This is not an abandonment rate caused by the chart.
- A fit recommendation needs per-product fit data. Only 2 of 40 top PDPs carry it today, so the content must be written or sourced (reviews, returns reasons, a fit tool). That is the main cost.

**Potential impact.** Directly, the 4–5% of PDP sessions that open the guide. Indirectly, every PDP session if the note sits beside the size selector.

**Potential financial impact.** The same scenario formula as Hypothesis 8. Mobile at 5% relative: $42,700 a month, $435,400 a year. **[D: FIN_impact_scenarios.csv · hypothesis=H10]**

**Draft ICE: I 6 · C 5 · E 5 → 5.3.**

- **Impact 6:** it targets the most uncertain sizing moment.
- **Confidence 5:** the drop-off after the guide is consistent with the hypothesis but is confounded by intent.
- **Ease 5:** the template is easy; the per-product fit content is the work. Start with the top 40 products, which carry most PDP traffic.

**Combine with Hypothesis 9?** Both target the same moment and the same metric. Either run them as separate arms (A: model line on image; B: fit note; C: both), or sequence them: H9 first, because it is cheaper and better evidenced.

---

### 4.6 Hypothesis 14 — Mobile category quick links above the hero

**The analyst's hypothesis**

| Field | Value |
| --- | --- |
| Funnel step | Homepage |
| Observation | On mobile, users must go through the menu or scroll before reaching relevant categories, adding friction to discovery. |
| Change | Add compact collection or category quick links above the video hero on mobile. |
| Hypothesis | If we add compact category quick links above the mobile hero, homepage → collection/PDP CTR will improve, because shoppers see relevant paths at once, fewer interactions are needed to start browsing, and high-intent visitors can skip homepage scrolling. |
| Primary metric | Homepage → collection/PDP CTR |
| Baseline (Sep) | All devices 24.82% |
| Secondary | Category-link CTR, PDP view rate, homepage scroll depth, time to first product/collection click, bounce/exit, add-to-cart rate, conversion |
| Heatmap link | https://portal.heatmap.com/funnels?idSite=5795&selected=207229 |

**What the data shows**

- **Half of mobile homepage visits end there.** Of 16,432 mobile sessions that loaded the homepage in September, the next page was a collection for 33.9%, a PDP for 10.6% (44.5% together), and nothing for 48.4%. Full-price days look the same. **[D: H14_homepage_progression.csv · population=all_home_visits, device=mobile]**
- **The menu is the working path, and it takes an extra tap.** 36.1% of mobile homepage sessions opened the menu. Those that did went on to a collection or PDP at 69.6%, against 30.3% for those that did not. For 34.4% of sessions the first navigation tap was the menu, a median of 8.1 seconds after load. **[D: H14_homepage_controls.csv · device=mobile] [D: H14_homepage_first_interaction.csv · measure=first_nav_click, device=mobile]**
- **The page content below the header is barely used.** 2.0% of mobile homepage sessions clicked a product tile and 6.4% clicked any other content link. 46.2% made no navigation tap at all. **[D: H14_homepage_controls.csv] [D: H14_homepage_first_interaction.csv]**
- **Most mobile visitors see only the top of the page.** Counting the fold as reached, 56.8% of mobile homepage sessions did not get past 25% of the page height, and the median time on the homepage was 16 seconds. **[D: H14_homepage_scroll_depth.csv · device=mobile] [D: H14_homepage_progression.csv]**
- **A popup is the first thing many visitors deal with.** 52.0% of mobile homepage sessions closed a popup. For 35.1% it was the first tap, a median of 4.8 seconds after load. 10.8% dismissed the cookie banner. **[D: H14_homepage_controls.csv] [D: H14_homepage_first_interaction.csv · measure=first_click]**
- **The homepage matters to revenue.** Mobile sessions that loaded it carried 35.6% of mobile session revenue in the recorded sample. **[D: FIN_impact_scenarios.csv · hypothesis=H14, exposure_share_of_device_revenue]**

**What cuts against it, or is missing**

- The 48% who leave include visitors who came for something else, such as the account page, a lookbook or a store link. Quick links will not move all of them.
- The popup may cover quick links placed above the hero during the first seconds. The test should check that the links are visible after the popup is dismissed.

**Potential impact.** Mobile homepage sessions, about 16,400 a month in the recorded sample, carry about $304,000 of mobile revenue a month.

**Potential financial impact** (mobile):

| If mobile homepage → collection/PDP rises by | Monthly gain, Sep basis | Annual gain, full-price basis |
| --- | --- | --- |
| 2% relative | $6,100 | $61,900 |
| 5% relative (44.5% → 46.7%) | $15,200 | $154,800 |
| 10% relative | $30,400 | $309,600 |
| +1 point absolute | $6,800 | — |

This assumes the extra visitors who progress convert like current progressors. Marginal visitors usually convert less, so treat these as upper bounds. **[D: FIN_impact_scenarios.csv · hypothesis=H14]**

**Draft ICE: I 5 · C 6 · E 7 → 6.0.**

- **Impact 5:** a third of mobile revenue passes the page, but the step is two steps away from the order.
- **Confidence 6:** the menu dependence and the near-zero use of content tiles are measured directly. The popup is a competing explanation for early exits.
- **Ease 7:** a theme section. A four-week test detects about 5% relative, the most testable of the six. **[D: TEST_minimum_detectable_effect.csv]**

**Test design notes.**

- Primary metric: share of mobile homepage sessions whose next page is a collection or PDP.
- Secondary: quick-link click rate, menu-open rate (it should fall), add-to-cart and purchase per homepage session.
- Guardrail: revenue per homepage session.

---

## 5. Notes across hypotheses

- **Three of the six target the PDP add-to-cart rate** (8, 9 and 10). Running them at once on the same pages confounds the results. Order them by ICE (9, then 10, then 8), or run a multi-arm test with enough traffic. The PDP has the most traffic, so a two-arm test detects about 7% relative on mobile in four weeks.
- **Hypotheses 1 and 4 have the same exposure** (all revenue) and the weakest evidence. The data points to two better-supported cart and checkout questions: why 28% of mobile add-to-cart sessions close the drawer, and why mobile checkout completion drops about 9 points on sale days.
- **Data-quality flag for the test team.** On mobile, the hidden Close button of the header search panel receives taps in 79% of sessions that start on a collection page and in 20% of those that start on a PDP. Some sessions record about nine such taps. That pattern looks like an invisible element over part of the page catching taps, or a tracking artefact. Check it in QA before running tests on collection pages or near the header. **[D: DQ_search_close_clicks.csv]**

---

## 6. Data dictionary

All tables are September 2026 unless a period column says otherwise. "Recorded sample" means sessions in Heatmap's session table after the bot filter (desktop sessions referred by Facebook with no medium and no campaign are dropped). Rates are shares from 0 to 1.

| File | Grain | What it holds | Used for |
| --- | --- | --- | --- |
| `SOURCE_analyst_hypotheses.csv` | One row per hypothesis | The analyst's sheet, unchanged: all 17 hypotheses, P0–P2 | All |
| `F1_daily_site.csv` | Day, 5 Aug – 11 Oct | Orders, revenue, AOV, share of orders paid below item price, `promo_day`, `period`; event-table session counts for PDP, add-to-cart, checkout started and completed; cart → checkout and completion | Context, H1 |
| `F2_funnel_by_period_device.csv` | Period × device | Recorded-sample funnel: sessions, homepage, PDP, add-to-cart, checkout started and completed, buyers, orders, revenue, conversion, add-to-cart per PDP session, cart → checkout, completion, AOV | Baselines, all |
| `F4_revenue_by_order_device.csv` | Order device | All September orders and revenue, plus full-price-day orders, revenue, AOV and a 30-day run rate | Financial |
| `F5_page_facts.csv` | Page × element | What the live pages show (12 Oct 2026): buttons, reassurance lines, model info, size guide, cart layout, what is not tracked | H1, H4, H8, H9, H10, H14 |
| `H1_checkout_completion_weekly.csv` | Week × device × scope | Checkout starts, buyers, completion; promo days in the week. `all_sessions_event_table` covers all sessions with all devices together; `recorded_sample` has device splits from 31 Aug | H1 |
| `H1_checkout_starters_by_segment.csv` | Segment × value × device | Completion by price period, new or returning, help-page view, size-guide use | H1 |
| `H1_help_pages_viewed_by_checkout_starters.csv` | Help page | Checkout-start sessions that viewed each help page in the same session | H1 |
| `H1_checkout_abandoner_followup.csv` | Device | Checkout abandoners 1–27 Sep, once per device id: returned and bought within 14 days, later revenue, median days to purchase | H1 |
| `H4_cart_controls.csv` | Device × control | Among add-to-cart sessions with click recording: share clicking each cart control (plus, minus, input, remove, drawer close, drawer checkout, cart-page checkout, recommendations, header cart) and their checkout-start and purchase rates | H4 |
| `H4_quantity_interaction_outcomes.csv` | Device × group | Add-to-cart sessions split into changed quantity, removed only, no quantity control; checkout-start and purchase rates | H4 |
| `H4_units_per_order.csv` | Device × units | Orders by units on the recorded line item (one line per order is stored) | H4, H8 |
| `PDP_engagement_by_device.csv` | Scope × device × denominator | Share of PDP sessions clicking each PDP control (Add to Bag, Buy it Now, Waitlist, size option, size guide, size-guide table, Size & Fit, Fabric & Care, reviews, gallery, colour swatch), add-to-cart event and purchase. Two denominators: all PDP sessions, and PDP sessions with any click recorded | H8, H9, H10 |
| `PDP_top30_products.csv` | Product × device | The same shares for the 30 most-visited products, mobile and all devices | H8, H9, H10 |
| `H8_purchase_button_clicks.csv` | Device | Click counts on Add to Bag, Buy it Now and Waitlist, and Buy it Now's share | H8 |
| `H8_purchase_button_outcomes.csv` | Device × button group | PDP sessions by which purchase button they used; checkout-start rate, purchase rate, buyers, session revenue | H8 |
| `H9_model_info_inventory.csv` | Product (top 40) | Size & Fit text, whether a model statement is present, size worn, sizing advice, fit words in the Description, where it sits | H9, H10 |
| `H9_H10_sizing_behaviour_vs_add_to_bag.csv` | Device × sizing segment | PDP pageviews by sizing behaviour; Add to Bag on that pageview, Waitlist, purchase in the session, median seconds on page, median scroll % | H9, H10 |
| `H10_size_guide_sequence.csv` | Device | Pageviews where the size guide was opened: used the chart, also opened Size & Fit, added to bag after opening, seconds to add, left without adding, waitlisted | H10 |
| `H14_homepage_progression.csv` | Period × population × device | Homepage sessions (all, and homepage entries): next page (collection, product, search, homepage again, other, exit), progression, purchase rate, revenue, median seconds on the homepage | H14 |
| `H14_homepage_scroll_depth.csv` | Device × reach band | First homepage view by the furthest point reached (fold counted as reached); progression, menu open, purchase | H14 |
| `H14_homepage_first_interaction.csv` | Measure × device × click class | First tap of any kind, and first navigation tap (popups, cookie and modals excluded); share, median seconds to the tap, progression | H14 |
| `H14_homepage_controls.csv` | Device × control | Share of homepage sessions using the menu, menu links, search, content tiles, popups and cookie banner, and progression with and without | H14 |
| `FIN_impact_scenarios.csv` | Hypothesis × device | Metric, baseline (September and full-price), exposed revenue, gain per absolute point, and gains at 2%, 5% and 10% relative lift: monthly on the September basis, annual on the full-price basis | Financial |
| `TEST_minimum_detectable_effect.csv` | Hypothesis × device | Monthly units, baseline, units per arm in a four-week 50/50 test, and the smallest detectable lift (80% power, 5% two-sided) | ICE (Ease), test design |
| `DQ_search_close_clicks.csv` | Device × entry page | Share of sessions with taps on the hidden search Close button | Data-quality flag |
| `key_numbers.json` | — | Machine-readable copies of a few headline figures | Optional |

**Click classes.** Clicks are labelled from the CSS selector of the element tapped. The labels were checked against the live page markup on 12 October:

- `product-form > … > div:nth-child(2) > div:nth-child(1)` is Add to Bag.
- `… > div:nth-child(2) > div:nth-child(2)` is Buy it Now.
- PDP block 9 is Size & Fit and block 10 is Fabric & Care.
- `quantity-counter > a` is Remove.
- The cart drawer header button is Close, and `form#cartForm … cart__buttons-all` is the drawer's Check Out.

**Scroll.** `scroll_y_max_relative` is stored on a 0–1000 scale; tables divide it by 10 to give percent. Homepage reach takes the larger of scroll and fold.

---

## 7. Method and caveats

1. **Rates come from recorded sessions, revenue from all orders.** About 22% of orders, mostly mobile, do not join to a recorded session. Financial scenarios therefore apply a relative lift to all-order revenue, not to the recorded subset.
2. **Click recording is partial.** 63% of mobile PDP pageviews carry no recorded click. Some of that is real (people look and leave) and some is unrecorded. Shares are given over all PDP sessions and over sessions with any click. Ratios between controls, such as Buy it Now against Add to Bag, do not depend on the denominator.
3. **Device ids are per device.** The abandoner follow-up cannot see a shopper who switches device, so return and purchase rates are lower bounds.
4. **The checkout is not tracked.** There is no Pay Now evidence in this pack.
5. **Engaged shoppers differ.** Segments defined by a click (size guide, quantity, menu) compare different shoppers, not the same shopper with and without the control. Only a split test isolates the effect.
6. **Financial scenarios assume the downstream rates hold.** A lift in an upstream step (homepage, PDP) often brings in marginal shoppers who convert less, so those figures are upper bounds.
7. **Live pages were read on 12 October 2026.** The September pages may have differed slightly. The block order was the same on every top PDP.
8. **Rebuilding the pack.** Run three steps in order:
   1. `node py/hypothesis-export.mjs` writes the warehouse extracts to `/tmp/hyp/raw/`.
   2. `python3 py/hypothesis-scrape.py /tmp/hyp/raw` fetches the live top-40 PDPs into `pdp_scrape.json`. It needs `beautifulsoup4`.
   3. `python3 py/hypothesis-build.py /tmp/hyp/raw docs/analysis/dvf/hypotheses/data` builds these CSVs.

---

## 8. Out of scope: the P1 and P2 hypotheses

These are listed for completeness. The report covers P0 only.

| # | Priority | Step | Change |
| --- | --- | --- | --- |
| 2 | P1 | Checkout | Move the two cross-sells above Pay Now |
| 3 | P2 | Checkout | Founder quote below Pay Now |
| 5 | P1 | Cart | Estimated delivery date above the checkout CTA |
| 6 | P1 | Cart | "Free Shipping \| X-Day Returns" below the checkout CTA |
| 7 | P2 | Sitewide | Popular search suggestions before typing on mobile |
| 11 | P1 | PDP | "In My Bag" instead of "Add to Cart" |
| 12 | P1 | PDP | "Complete the Look" module from basket analysis |
| 13 | P2 | PDP | Wishlist icon on PDP carousel cards |
| 15 | P1 | Sitewide | Star rating and review count on product cards |
| 16 | P2 | Sitewide | Wishlist icon on all product cards |
| 17 | P1 | Sitewide | Returning-cart experience with "Continue Checkout" |
