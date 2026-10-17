# Capture the page before analysis

**Supersedes `NAMING-BEFORE-ANALYSIS.md`.**

This is the integration contract for the coding agent working in
`/Users/kennpalm/source/heatmap/cnn-ai-bot`.

The schema-2 engine (`src/cli.js`, `src/runner-ae.js`) refuses to analyze a
selected page until the page has a **fresh capture**: `ae_page_capture`
`status = complete` on the engine's current `TAXONOMY_VERSION`
(`src/domain/taxonomy.js`, taxonomy v2, 54 classes). The capture gate
re-enqueues anything stale as `want: ['naming', 'render']`,
`device_classes: ['desktop', 'mobile']`, with the queue `reason` set to
`taxonomy_upgrade` (a complete capture on an older taxonomy) or `no_capture`
(no row at all). The capture consumer (`src/capture-consumer.js`) claims
`ae_capture_queue` rows, runs the naming bot as a configured external command,
reads the harvested artifacts, and calls `completeCapture`, which writes
`ae_page_capture` + `ae_element_binding` + the render tables and re-queues
waiting sites.

Per data-capture-plan.md §9.3, a capture is **naming + render + saliency**:

- **naming** (`names.json`) — the Phase 2 contract, unchanged.
- **render** (`render.<device>.json` + screenshot) — this document's contract;
  written next to `names.json`, one artifact per device class.
- **saliency** — the saliency worker claims captures with `want` containing
  `saliency` and rewrites render nodes with predicted-attention shares;
  behind a feature flag until the plan's Q8 is resolved.

## Render artifact (`render.<device>.json`)

Written at `dataset/{idsite}/{kind}/{slug}/render.<device>.json`, same
directory rule as `names.json`:

```json
{
  "url": "https://…", "device_class": "mobile", "viewport": { "w": 390, "h": 844 },
  "page_height_px": 9120, "fold_px": 844, "rendered_at": "2026-10-…Z", "renderer_version": "…",
  "content_hash": "sha256:…", "dom_hash": "sha256:…", "screenshot": "screenshot.mobile.png",
  "sections": [ { "id": "s3", "selector": "…", "top": 1688, "height": 1210, "type": "reviews_block", "words": 412 } ],
  "elements": [ { "selector": "…", "section_id": "s3", "dom_order": 41, "x": 16, "y": 1720, "w": 358, "h": 48,
                  "is_control": true, "looks_clickable": true, "sticky": false, "visual_class": "control",
                  "image_type": "", "words": 3 } ]
}
```

Required top fields: `url`, `device_class`, `viewport {w, h}` (both > 0),
`page_height_px`, `fold_px` (both ≥ 0), `rendered_at`, `renderer_version`,
`content_hash`, `dom_hash` (hashes non-empty strings). `screenshot` names the
screenshot file beside the artifact (optional; missing file is a note, not a
failure). Extra blocks (`commerce_controls`, `form_fields`) pass through.

## Validation (src/capture-artifact.js)

`validateRenderArtifact(artifact, bindings)` throws with a precise message on
the first violation; the consumer failCaptures naming the device class:

- `sections[]`: each needs `id` (non-empty string), `top`/`height` ≥ 0;
  `selector` is optional.
- `elements[]`: each needs a non-empty `selector` and a numeric box with
  `w`, `h` ≥ 0 and `x`, `y` ≥ −1 (1 px rounding tolerance; anything further
  off-screen is rejected).
- **Binding contract**: every selector in `bindings` (the mapped names) must
  exist among `elements[]` selectors — a bound selector that did not render
  fails the artifact.

## What completeCapture writes

- `ae_page_capture` — one row, `has_render = 1` when renders are present
  (`has_saliency` stays 0 until the worker runs); `coverage` JSON adds
  `{named_selectors, devices, elements_bound, sections_found}`.
- `ae_page_render` — one row per device class: viewport, page/fold heights,
  `screenshot_uri`, hashes, `section_order` (section ids), `rendered_at`,
  `renderer_version`.
- `ae_render_node` — one node per section (`node_kind 'section'`, the
  section's own id, full-width geometry from `top`/`height`) and per element
  (`node_kind 'element'`, `parent_section_id` from the artifact), saliency
  fields null.

**Render drift (§9.3):** before writing a device's row, the current
`content_hash` for `(idsite, idsitehsr, device_class)` is read; on a
difference one `ae_change_log` row is written — `change_kind 'content_drift'`,
`source 'render_diff'`, `change_id render_drift:<idsitehsr>:<device>:<new hash
slice>`, `subject` the page url, `detail {old_hash, new_hash, device_class}`,
`effective_at` the artifact's `rendered_at`. The drift row expires the page
descriptor (PG:S14, PO's per-window render diff).

## Screenshot landing (Q9 default)

Object store unresolved → local disk on the capture host, 90 days. When the
artifact names a screenshot that exists beside it, the consumer copies it to
`<datasetRoot>/../captures/<idsite>/<idsitehsr>/<device>.<file>` (directories
created) and stores the dataset-relative path
(`../captures/<idsite>/<idsitehsr>/<device>.<file>`) as `screenshot_uri`. A
missing screenshot file is a note in the log, not a failure (`screenshot_uri
''`).

## Fail closed

A page without a fresh capture is not analyzed; a device class the job
requested but the bot did not deliver (missing or unparseable
`render.<device>.json`, or a failing validation) failCaptures with the device
named; element classes outside the taxonomy are dropped by
`src/naming-mapper.js`.
