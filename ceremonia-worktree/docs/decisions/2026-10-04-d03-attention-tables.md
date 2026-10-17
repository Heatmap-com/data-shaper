# D-03: exposure and dwell from `udp_am_*` (plan §12 P0 row 3; H18)

**Answer (probed):** `udp_am_zones` has 20 bands (`zone_d` 5..100 step 5)
with `dw` (seconds) and `dw > 0` as the exposure flag; `zone_ref_height`
is populated on some rows (band→pixel where present; the band index itself
is the depth percent otherwise). `exp` ∈ {0,1,2} and `fv` ∈ {0,1000,1001,
1002} semantics are unconfirmed — the engine reads `dw` only.
`udp_am_elements` enrols 12–39 selectors per page on 3199 (31 on the
bundle builder), confirming the attention ration. Retention spans the full
tracked range.

**Decision:** H18 is built in Phase 3 from `udp_am_zones` + `udp_am_elements`
exactly as §6.2 describes: band→section mapping uses `ae_render_node`
geometry when Phase 4 lands, and the descriptor's section-top depths
(field p10) until then. No TTL is assumed on `udp_am_*`.
