# Analysis document standards

Shared rules for the Site Opportunity Report, Today Opportunities, and User Journey Opportunity Analysis. Read this before writing any of them.

## Where the documents go

Write markdown in `docs/analysis/<slug>/`:

- `{Brand} — Site Opportunity Report.md`
- `{Brand} — Today Opportunities.md`
- `{Brand} — User Journey Opportunity Analysis.md`

Charts go in `docs/analysis/<slug>/media/` and are referenced as `media/<file>.png`. Do not commit unless asked.

Format reference: the Loop Earplugs `.docx` files in `~/work/analysis/reports/`. Match their section order, table style, and voice. A small-site markdown example is `docs/analysis/ceremonia/`.

## Voice

Write as a CRO analyst for the operator who can change the site or the ad account this week.

- Lead with the finding, then the number, then the action.
- Anchor every number against the prior fortnight, a peer slice in the same table (device, channel, page, journey), or the next funnel step. Do not print a naked rate.
- Do not invent a benchmark, a median, or an industry rate the bundle does not contain.
- Monthly dollar figures are estimates from this window's volumes. Call them upper bounds, not forecasts. Say what behaviour you assumed (for example, re-pointed traffic converts like the destination's existing traffic).
- Scale the dollars to this site. Do not reuse another site's opportunity sizes.
- Flag a rate built on fewer than about 100 visits or about 10 orders as directional. On a large site, flag a segment that is thin relative to that site instead.
- State points directly. Do not contrast the finding with an alternative the reader did not ask about.

## Data rules that change the writing

- Visit rates use human visits. Dead sessions (one page or none, no click, no scroll, no order) are excluded and stated once, as a count and a share of raw traffic. `page_period` still includes them. A homepage row often has a null URL and `pc = home`; treat that as `/`.
- `entry-by-channel` counts entry sessions and will not match human-visit totals. Compare rows inside one table. Do not mix the two denominators in one sentence.
- Channel is last touch: the link the visit arrived on. Say so when a channel looks weak or strong. Ad spend is not in the bundle, so revenue per visit is on-site value only.
- `orders.item_title` is the highest-priced line. `items` is not a reliable basket count. Infer a multi-item basket from `paid_to_item` (order revenue divided by item price times qty). The `line-items` table, when present, is a separate and often partial extract.
- Do not treat `hist30 = bought_before` as a repeat-purchase rate until you check it. On some extracts every buying visit is labelled `bought_before` because the visit's own order counts. If buyer visits and `bought_before` visits are nearly the same number, use the returning flag (`ret`) instead and say the 30-day flag cannot measure repeat rate.
- Peak days are the three highest-revenue days in `00_site_profile.json`. Check who converted on those days before naming a cause. A lift across every channel at once is a promotion or a code, not a retention story. If the bundle has no promotion calendar, say that.
- A shipping or gift threshold comes from the live site or from on-page copy in the bundle (announcement bar, cart). Record the date you read it. The order histogram shows where baskets sit relative to that line. Do not invent the line from the histogram.
- The analysed page in the bundle is `analysed_page` in `00_site_profile.json`. Pipeline tables (files 07–09) describe that page, which may not be the homepage.
- In a `-4mb` bundle, `orders` has no `d` column while it is still one row per order. The date is the first 10 characters of `t_utc`. If `00_site_profile.json` says orders were rolled up, the grain is day × product × device and the median anchor is gone. Prefer the full bundle for the documents.

## Charts

Each report stage declares its charts in `orchestration/stages/<stage>.stage.json` under `charts` (file stem, chart type, parameters). The `chart-render` stage draws them with `py/chart-render.py` from the full bundle into `docs/analysis/<slug>/media/`, in the palette from `scripts/report-style/tokens.json`, and writes `media/charts.json`: each chart's file, title, and whether it was drawn or skipped with the reason. A document embeds the drawn charts it cites, writes each caption from the bundle's numbers, and says in the section when a chart was skipped because its table is empty. A new chart type is one function in `py/lib/chart_types.py`; a site adds or drops a chart with a `patch` in its run.

For a one-off chart outside that path, use matplotlib with the DejaVu Sans font and keep axis labels from overlapping. Math text is off in `chart-render`; elsewhere a dollar sign in a label must be escaped (`\\$`).

## Method footer

Each document ends with a method section: window dates, dead-session rule, last-touch channel, that sizes are upper bounds, and any break in the data (an event definition that changed, a tagging gap, a partial line-item extract). Do not claim a measurement the method section says is missing.
