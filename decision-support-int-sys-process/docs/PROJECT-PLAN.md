# Project plan

Enterprise data enrichment. The grain is `ae_trend_row`, described in `docs/VISION.md`. This plan is the order of work from the current extract to the two readings a coach asked for, then to pages and elements on that same grain.

Dates: a strategy review on 14 October 2026, facets answering from this table by 8 November 2026, and a usable subset for the coaching conversation on 15 November 2026.

The Roswell catalog is the roadmap of measures. The rows it already stored stay in `ae_dataset_row` as evidence. New week-over-week readings are written with `buildTrendRow` and `writeTrendRows`. A new segmentation is a new `segment` value, not a new table and not a new metric column.

## Grain rules

- One row is one subject, one week, one strategy, one value.
- `segment = all` and `segment_value = all` is the total. Store it. Do not add the values of a strategy together and call that the total unless the values are a partition and the total row is missing.
- Do not sum across strategies. A session that is `meta` and `new` is two rows on purpose.
- `traffic_source` is a partition. `meta` is one value, from the UTM sources `facebook`, `ig`, `fb`, `instagram`, and `facebookads`. The other values cover everyone else exactly once. Referrer channel `Paid` and `Social` stay available as their own values only if they do not overlap `meta`. Pick one partition and document it on the query.
- Keep the subject list fixed across weeks. Rank money paths once. Rank important pages once, and add pages a person has flagged. A weekly re-rank hides a path that fell out of the top three.
- `week` is the Monday. `idsite` is always set. `idsitehsr` is the page id or `0`.
- The shared measures are `sessions`, `buyers`, `orders`, `revenue`, `clicks`, `progressed`. Anything else goes in `metrics`.

## 1. Journey, week over week, with the first strategies

This is the first value. It does not wait on naming.

Question it answers: how is Meta performing on the top money paths, week over week, and how does each step move for the other strategies.

Subjects:

- `row_type = journey`, `row_key = path`, `row_key_1` the template path. Metrics for the whole path.
- `row_type = journey`, `row_key = step`, `row_key_1` the step name. Metrics for that step.

Strategies on both: `traffic_source`, `returning`, `buyer`, `rager`, and `all`.

The current extract has the pieces and not the row. F6 has path revenue for one window and no source. F7 has weekly path sessions and no revenue. F1 and F3 have weekly referrer channel and no path. X2 has Meta's UTM sources for one window, sitewide, capped at 100 combinations. None of those rows are this grain.

Done when a facet can filter `segment = traffic_source`, `segment_value = meta`, `row_key = path`, and read `sessions`, `buyers`, and `revenue` for each Monday, next to the `all` row for that path.

## 2. Pages, on the same strategies

Question it answers: week-over-week performance of page types and of the important pages, cut by the same strategies as the journey.

Subjects:

- `row_key = template`, `row_key_1` one of home, collection, product, cart, search. The H1 measures, which today exist weekly by device and new versus returning and by no source.
- `row_key = page`, `row_key_1` the page id, `row_key_2` the URL, `idsitehsr` the page id. The L6 and P6 leagues are the starting list. They are one 28-day snapshot today, and they do not store the URL.

P7 is the only current series that is both weekly and split by referrer channel, and it pools every product page into one add-to-cart rate. It is a check on the new rows, not a substitute.

A page gets into the weekly set because it is on the revenue list or because it was flagged. The job looks up which weeks that page is missing and backfills those weeks.

## 3. Elements, on the same strategies

Question it answers: week-over-week performance of the important element classes on the important pages, cut by traffic source and the other first strategies.

Subject: `row_key = element_class`, `row_key_1` the class, `row_key_2` the selector, `idsitehsr` set when the row is one page.

This stays empty until names are trustworthy. The current scorecards have a class and zero clicks, because every live selector starts on 6 October 2026. The weekly element queries stored no rows. G6 has raw selector click counts for one window and no source. Fixing `valid_from` is necessary and it is not sufficient: after clicks match, they still have to be written as trend rows under a segment.

Important classes come from three places: the classes the naming system already treats as important, the classes this job reports as carrying data, and site-specific regular expressions in config. Heuristics alone are not the rule.

`clicks` is the element measure. `revenue` on these rows is correlational and is labeled that way in `metrics`.

## 4. Facet, then the coaching subset

The facet reads `ae_trend_row_current`. It can be built against sample rows of the journey grain while item 1 is still being filled. By 8 November 2026 it answers, in production, the journey-by-source trend and the element trend on key pages. By 15 November 2026 a subset of strategies is enough for the coaching conversation. Experiment is the reading after these, in the same table.

## Beside this, not in front of it

- Naming reliability, with Joseph Barnes, during the journey and page work. Element rows start producing real numbers when that track says the classes are trustworthy. Agentic naming is part of that track.
- A governor on how many aggregation jobs run, so they use idle ClickHouse CPU and do not crowd out collection.
- An API on the same table, after the facet.
- An admin path that accepts a packaged strategy, checks it, and registers it. Not the shipping path for items 1–3.
- Shopify theme scope, so a name can be judged stale from the theme update time. Not required for the journey.

## Review on 14 October 2026

Say which of the current audit queries are the source of item 1, and which of the runner gets rewritten. The grain in `docs/VISION.md` is the part that does not get re-decided. Success on that day is a written strategy, not a filled table.
