# D-08: saliency model and screenshot store (plan §12 P0 row 8; M04, Q8, Q9)

**Answer (operator):** no model selected; no object store designated.

**Decision (Q8/Q9 defaults):** M04 is `missing` with detail
`model_not_selected` until a commercially-licensed model is chosen; every
M04-dependent strategy (PO C-family, PI:C1–C3/E3/G3, PG:A1/A2/A4) produces
`conditional` cards naming M04, as PG itself requires. Screenshots land on
**local disk on the capture host with a 90-day retention**; the
`ae_page_render.screenshot_uri` column stores the path/URI only, never the
image. The saliency worker ships behind a feature flag (Phase 4).
