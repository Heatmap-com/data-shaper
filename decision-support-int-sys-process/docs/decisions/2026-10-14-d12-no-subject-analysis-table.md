# D-12: non-page subjects have no analysis table of their own (execution-profiles plan §9; P5, P6)

**Decision:** an experiment, a funnel, or a journey ends as its dataset
rows, its strategy cards, and its requirement status, all keyed by subject
(D-11). Each card carries its metrics and dims in `card_json`, and the
requirement status of the subject's readout key (H16, H12, H20) lives on
the cards. The landing-page profile keeps `ae_page_analysis` and
`ae_site_analysis`, and also writes `ae_subject_target` for its pages.

**Rejected:** a generic `ae_subject_analysis` table holding a JSON blob per
subject. The v1 `metadata` column showed that blobs resist SQL filtering.
A column is promoted out of the cards when a consumer needs to filter on
it.
