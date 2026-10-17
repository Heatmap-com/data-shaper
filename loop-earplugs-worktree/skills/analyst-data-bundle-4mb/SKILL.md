---
name: analyst-data-bundle-4mb
description: >-
  Builds the trimmed analyst data bundle (~4 MB) from a site's full bundle.
  Use when the user asks for the 4mb folder, the size-capped copy, or both
  data folders for a site. Requires the full bundle first.
---

# Trimmed analyst data bundle

Build `~/work/analysis/<slug>-4mb/` from a full bundle that already exists. If `~/work/analysis/<slug>/` is missing or failed its anchor check, run `skills/analyst-data-bundle/SKILL.md` first. Do not trim the export's `--out` directory (for example `/tmp/bundle/<slug>/`); it holds raw extracts, not the bundle.

Always run the trim, including when the full folder is already under 4 MB. Kurk and Ceremonia were both under 4 MB and still received this copy.

```bash
python3 py/bundle-trim.py ~/work/analysis/<slug> ~/work/analysis/<slug>-4mb
```

## What the trim changes

These rules are in `py/bundle-trim.py`. Do not add a second trim by hand.

- Page × period × device rows under 25 visits are summed into `(pages under 25 visits, summed)` per page class × period × device.
- Product-entry rows under 10 visits and with no buyer are summed into `(small)` per period × product URL. Rows with a buyer stay.
- Campaign-days under 5 visits and with no buyer are summed per date × `link_ch`.
- Selector-weeks under 3 clicks are summed per week × device. Columns `m_p25_y`, `m_p75_y`, and `m_median_time_since_load` are dropped.
- Tap geometry keeps only selector-weeks with an off-target tap, a correction pair, or a measured offset.
- Long CSS paths keep the first 2 steps and enough of the tail to stay unique (at least 5).
- `selectors` keeps only ids still referenced, with shortened paths.
- `01_orders.csv` drops `d` while it is still one row per order. The date is the first 10 characters of `t_utc`.

If the result is still over 4.2 MB, the script rolls orders up to day × product title × markdown × device × high-value, for the report window only, and drops the median anchor. If it is still over 4.2 MB, a second pass sums low-volume source weeks, creatives, campaign weeks, and order lines. The script records which pass ran in `00_README_data_guide.md` and `00_site_profile.json`. Read those notes before describing the folder.

`.anchors.json` is not copied. `00_` and `10_` files are.

## Check

Confirm the order anchors in `00_site_profile.json` against `01_orders.csv`.

- Per-order trim: there is no `d` column. Derive the date as `t_utc` sliced to 10 characters, then check count, revenue, median, and high-value anchors the same way as the full bundle.
- Rolled-up orders: `orders_grain` in the profile says day × product. Count is `sum(orders)`, revenue is `sum(order_revenue)`, and there is no median anchor. Check only the anchors the profile still lists.

The two folders will not have the same row counts. They must have the same window revenue and order count within the anchor tolerances, unless the rollup dropped orders outside the report window (the full file includes those; the rollup keeps the window only). When that happens, say so.

State both paths, both sizes, whether orders are still one row per order, and the anchor result.
