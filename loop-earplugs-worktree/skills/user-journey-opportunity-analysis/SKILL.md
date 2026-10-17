---
name: user-journey-opportunity-analysis
description: >-
  Writes the User Journey Opportunity Analysis for one site: how shoppers move
  from landing page to product, cart, and order, and where that path leaks.
  Use when the user asks for a user journey analysis, journey opportunity
  report, or the document matching the Loop Earplugs User Journey Opportunity
  Analysis.
---

# User Journey Opportunity Analysis

Read `skills/analysis-doc-standards.md` first, then the Loop Earplugs User Journey Opportunity Analysis in `~/work/analysis/reports/`. Write `{Brand} — User Journey Opportunity Analysis.md` in `docs/analysis/<slug>/`.

Use the full bundle. Journey tables come from `visit_cohorts` (`journey3`, `n_prod`, `saw_*`, `coll_to_prod`, `c_reviews`, `c_faq`, `c_search`, scroll bands), `entry-by-channel`, `page_period`, `weekly_entry_cube`, and `daily_site`.

## How to read a journey

Open the document with the Loop "How to read a journey" callout, rewritten for this site. A journey is the sequence of page classes in a visit: home, product, collection, content, other. Consecutive repeats of a class count once. On these bundles, `other` often holds product URLs stored with a full domain, including paid landing pages. Say that, and combine it with `/products/` when you talk about product-style entries. Quick-add means a buying visit can be one tracked page, so "one page class" is not "no order".

## Compute before drafting

1. One-page-class visits versus any journey that changes class. Order rate and revenue per visit for: one class only, product only, reached a product, two product pages, three or more, collection → product, reached the homepage, review clicks, search, FAQ.
2. Entry channel by single-page share and revenue per session (`entry-by-channel`). Landing pages that take volume and convert near zero, next to the page beside them that converts.
3. Funnel by phase: `pre`, the report window, and the three peak days. Visits per day, orders per day, add-to-cart, cart to order, conversion, revenue per visit. If checkout-per-cart jumps while orders stay flat, treat it as an event change and say so. Read the funnel at cart → order until that event is verified.
4. New versus returning by week from `weekly_entry_cube` (`ret`). Apply the bought-before check in the standards file before any repeat-purchase sentence.
5. Five smaller behaviour signals from the cohorts (scroll band, dwell band, popup, search, FAQ, rage). Keep a signal only when the rate differs from the site and the count is large enough to mention. Say what to do with it.

Rank by journey evidence, not by traffic volume. The rank will often put a quiet high-value path above a large cheap landing. Dollar sizes are upper bounds, and shoppers who browse further are partly different people. Say that next to any "move N one-page visits" estimate.

## Document order

1. Header and the how-to-read callout.
2. Contents.
3. **01 The Month in Journeys.** A measure table (orders, where visits land, most common journey, best common journey, homepage effect, second-product effect, peak days) and a weekly-revenue chart.
4. **02 The Journeys That Make Money.** A revenue-per-visit chart and a journey table, then bullets. End with a "So what" callout: judge merchandising by the second product view it creates.
5. **03 Where the Journeys Leak.** Entry-channel single-page table, then the landing pages that leak, each with the page next door. A "So what" callout with the upper bound.
6. **04 How the period reshaped the funnel.** Phase table. State whether the change is traffic or conversion. Daily checkouts per add-to-cart only when it shows a break or a spike worth seeing.
7. **05 Recent buyers, or returning visitors.** Use the measure the data actually supports. Weekly new-versus-returning table. A "So what" callout.
8. **06 Behaviour signals worth watching.** Five or fewer.
9. **07 Where the journey data points.** A priority table (move, journey evidence) and four weekly numbers to track.
10. **A Data and Method.**

Cross-refer the Site Opportunity Report by opportunity name when a leak is specified there. Do not repeat its action list.
