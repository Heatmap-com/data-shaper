# D-07: experiment arms and page-speed coverage (plan §12 P0; H15, H16)

**Answer (probed):** `udp_partner_tags` covers 3199 (24 experiences /
52 variants) and 3228 (33 / 64); **3207 has no partner tags** — H16 is
`not_applicable` there. `journey_events.page_speed_cache` has **zero rows
for all three pilots** despite 1,242 rows fleet-wide (June model).

**Decision:** H16 is built in Phase 3 with per-site availability
(`not_applicable` where no tags exist). H15 stays `partial` on the pilots:
`page-speed` reads `page_speed_cache` plus `ae_src_page_perf` (A03, CrUX)
when Phase 9 lands; page-speed-dependent cards on the pilots stay
`conditional` naming H15/A03 rather than estimating.
