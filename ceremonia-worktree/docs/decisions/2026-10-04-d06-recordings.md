# D-06: recordings population filter (plan §12 P0 row 6; H17)

**Answer (probed):** `recordings_new1` is filterable by page
(`idsitehsr`, `event_href`), device, date, duration (`time_on_page`) and
engagement (`pageview_click_count`), with 2.6M–9.4M rows per pilot, current
through 2026-10-04.

**Decision:** H17 is available in Phase 3. `recordings-sample` filters the
named population a card requests (for example mobile paid-social
long-dwell non-buyers) and stores recording ids + count; it never stores
replay content. Element-level filtering uses `selector-weekly` join rates
rather than replay parsing.
