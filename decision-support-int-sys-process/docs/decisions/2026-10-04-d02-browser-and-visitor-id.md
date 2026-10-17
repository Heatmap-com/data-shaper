# D-02: browser cut and cross-session visitor id (plan §12 P0 row 2; H06, H27)

**Answer (probed):** `udp_hsrce_visits` carries `config_browser_name` /
`config_browser_version` → H06 is available from L1 in Phase 3 as a
dimension on `page-segment-weekly`, `selector-weekly`, `rage-clicks`.
No cross-session visitor id exists: `udp_hsrce_pageviews.visitor_id` is
unique per visit (26,144 visitors = 26,144 visits on 3199 in the check
week), i.e. a per-session token.

**Decision:** H06 → available (Phase 3). H27 → `missing` with detail
`no_stable_visitor_id`; returning-visitor strategies (PO:F3, PI:F4, PG:J4,
TG:C5 identity legs) use the `visitor_returning` flag only and are marked
`partial`, exactly the Q10 default. Revisit only if the tracker adds a
stable visitor key.
