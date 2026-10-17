---
name: analyst-data-bundle
description: >-
  Builds the full analyst data bundle for one site: ClickHouse extracts, then
  the order, visit, page, and pipeline files under ~/work/analysis/<slug>/.
  Use when the user asks for a site's data folder, a full export, an analyst
  bundle, or the data behind a Site Opportunity Report.
---

# Full analyst data bundle

Build `~/work/analysis/<slug>/`. This is the complete folder: one row per order, every page and campaign row, full CSS paths. The 4 MB copy is a separate skill (`skills/analyst-data-bundle-4mb/SKILL.md`). Run this one first.

Do not print ClickHouse passwords. Do not query `system.metrics`, `system.processes`, `system.query_log`, `system.asynchronous_metrics`, or `system.columns`.

## 1. The site spec

The exporter reads `orchestration/sites/<slug>/site.json`. If the site has none, write it. Bundles need:

- `slug`, `name`, `domain`, `idsite`, `currency`, `platform` (lower case, for example `shopify`).
- `focus`: `{ "path", "label", "idsitehsr" }`, the page whose pipeline tables (clicks, scroll, rage, exposure) the bundle should contain. Use the advertising landing page when the site has one. For the homepage, `path` must be `"/"`. An empty string matches nothing.

Optional:

- `periods`: the site's own calendar, as `[{ "name", "end", "baseline"?, "about"? }, ..., { "name" }]`. The first period starts 14 days before the window, each next one the day after the previous end, and the last ends with the window. `baseline` marks the full-price period that markdown detection uses; without one, the first period inside the window is the baseline. Without `periods`, the bundle uses `pre`, then the window's two calendar halves `first` and `second`.
- `readingNotes`: `{ "profile": [...], "notIncluded": [...] }`. `profile` replaces the last profile reading note ("Amounts are the revenue stored on the order."). `notIncluded` adds lines to the guide's "Not included" list.

Resolve `idsite` and `idsitehsr` from the warehouse. Do not invent them. If either cannot be resolved, stop and ask.

## 2. Export

`CLICKHOUSE_HOST`, `CLICKHOUSE_PORT`, `CLICKHOUSE_USER`, and `CLICKHOUSE_PASSWORD` must be in the environment. If they are not, load the repo `.env` without printing it.

The visit extract runs eight history-partition shards sequentially so large sites stay below the warehouse join-memory limit. `BUNDLE_VISIT_SHARDS` overrides the count when needed; do not reduce it after a memory-limit failure.

```bash
node py/bundle-export.mjs --site orchestration/sites/<slug>/site.json \
  --window-start YYYY-MM-DD --window-end YYYY-MM-DD --out /tmp/bundle/<slug>
```

The window is the inclusive report window. Use the dates the user names, else the window of the site's last bundle. `--out` is the extract directory. It receives `meta.json`, `orders.json`, `visits.jsonl`, `page_period.json`, `hv_page_reach.json`, `pipeline.jsonl`, `trigger_chains.json`, `dwell.json`, and `rage_totals.json`. The visit extract is long. Run one site at a time, log to a file, and wait for `<slug> visits done`.

Resume flags, only after a failed run of the same site, window, and `--out`:

- `BUNDLE_RESUME=1` reuses `orders.json` and skips page and pipeline extracts.
- `BUNDLE_RESUME=1 BUNDLE_REFRESH_PAGES=1` reuses orders and pipeline, and re-queries pages.

Do not set `BUNDLE_RESUME` on a first run or after the site's window, focus page, or periods changed. Delete the extract directory and export again instead.

## 3. Build

```bash
python3 py/bundle-build.py /tmp/bundle/<slug> ~/work/analysis/<slug>
```

The folder contains:

| File | Contents |
| --- | --- |
| `00_README_data_guide.md` | How to load tables, periods, channel definitions |
| `00_site_profile.json` | Window, analysed page, anchors |
| `.anchors.json` | Same anchors, for the check below |
| `01_orders.csv` | One row per order, with `d` |
| `02`–`09` `.txt` | `=== TABLE: name ===` blocks. `@@` lines repeat the header every 100 rows; skip them when parsing |
| `10_SITE-NOTES.md` | Headline counts |

`pre` starts 14 days before the window. Without site `periods`, `first` runs from the window start through 14 days later, inclusive, and `second` is the rest. `peak` is the three highest-revenue days. High value is the in-window 90th percentile of order revenue, rounded to the nearest 10.

## 4. Check the anchors

Load `01_orders.csv`, filter `d` to the report window, and match `00_site_profile.json` `anchors`: order count, revenue (tolerance $1), median order (tolerance $0.01), high-value order count, and high-value revenue. On a mismatch, fix the build or the filter. Do not hand-edit the anchors to match.

Then state the folder path, its size, the window, the order count, the revenue, and the anchor check.
