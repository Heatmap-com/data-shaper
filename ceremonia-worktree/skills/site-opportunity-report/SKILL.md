---
name: site-opportunity-report
description: >-
  Writes the Site Opportunity Report for one site from its analyst bundle.
  Use when the user asks for a site opportunity report, the monthly
  opportunity write-up, or the long-form CRO report matching the Loop
  Earplugs Site Opportunity Report.
---

# Site Opportunity Report

Read `skills/analysis-doc-standards.md` first, then the Loop Earplugs Site Opportunity Report in `~/work/analysis/reports/`. Write `{Brand} — Site Opportunity Report.md` in `docs/analysis/<slug>/`.

Use the full bundle at `~/work/analysis/<slug>/`. If it is missing, build it with `skills/analyst-data-bundle/SKILL.md` before writing. Do not write from the `-4mb` folder when the full folder exists.

## Compute before drafting

Work in this order. Skip a block the bundle does not contain, and name the gap in the method section.

1. Window totals from `orders` and `daily_site`: orders, revenue, average and median order, device share of orders, human visits, dead sessions, returning share, high-value orders. Compare orders per day, revenue per day, average order, visits per day, add-to-cart, and conversion with `pre`.
2. Weekly orders and revenue. Mark the three peak days. Do not explain them until the journey or channel split says who bought.
3. Device funnel: visits, add-to-cart, cart to checkout, checkout to order, conversion, revenue per visit.
4. Referrer channel (`ch`) and campaign-link channel (`link_ch`): visits, conversion, revenue per visit. Then the campaigns and creatives inside the weak paid channel, each with visits, cart adds, checkouts, orders, and revenue per visit. Keep a row only when it has enough volume to act on, or when it has volume and zero orders.
5. Cart and browse recovery from `trigger-chains` where `final = 1`: chains, return rate, purchase rate, revenue, by device. The cohort is the first part of the window, followed 14 days. Say that.
6. Order-value histogram against a real shipping or gift line, if one is on the site. High-value page reach (`over_index`) for what those buyers actually view. Product titles by revenue.
7. Entry pages from `page_period` and `entry-by-channel`: visits, buyer rate, entries, entry-buyer rate, single-page share. Separate pages that convert from pages that take traffic and do not.
8. Analysed-page scroll, rage, and top clicks. Say which page it is.
9. `shopper_history_30d` and `ret`, applying the bought-before check in the standards file. Email and flow volume. Country split. Anything that makes a rate unreadable: untagged paid traffic, a checkout-event step change, a dead-session spike, coupon-extension last-click credit.

## Document order

Match the Loop report:

1. Header: brand, domain, window, prepared date, one sentence on orders, human visits, and what was re-analysed.
2. Contents.
3. **The biggest wins, first.** Six numbered moves. Each is one sentence of evidence, the action, and the opportunity it points to. No new numbers that are not in the opportunities below.
4. **At a glance.** One table, about ten rows: finding, recommended action, priority (`High`, `Medium`, `Watch`).
5. **The month in numbers.** A definition table, then weekly orders, then the daily-orders chart. Close with the two contexts that change how the month should be read (volume versus the prior fortnight, and where demand concentrates).
6. **Eight opportunities.** Each has `What we saw` (table, then bullets), `Why it matters` (one monthly size, as an upper bound), and `Recommended actions` (imperatives an owner can do). Use fewer than eight only when the bundle does not support eight. Do not pad.
7. **Worth watching.** Short subsections for lines that moved and are not yet an opportunity.
8. **What's working.** Areas checked that need no change. Only include a line you actually checked.
9. **Suggested next 30 days.** Week, action, owner.
10. **Method and caveats.**

Default opportunity set, replaced when this site's data says otherwise: cart recovery, the weak device, basket threshold, paid channel accountability, the analysed landing page, dead-end destinations, retention or replenishment, measurement hygiene.

Charts, when the data exists: daily orders with peak days marked; cart recovery by device; device funnel; order-value distribution with the real threshold lines; revenue per visit by channel; scroll depth on the analysed page.
