# D-01: custom-event payload shape (plan §12 P0 row 1; §6.1)

**Answer (probed):** `udp_custom_events` and `journey_custom_map` have no
properties/JSON column — only `event_type String`, `event_id Int32`,
`event_count`. Both tables hold **zero rows for the pilots** today.

**Decision:** The §6.1 fallback is in force: one event name per state
(`module.action`, item in properties), properties encoded in `event_id`
until the tracker adds a properties column. Event names are a closed set
held in `src/catalog/events.json` (T21 registry). Every T-family
requirement is `missing` on the pilots until the tracker workstream (Q6)
ships emission; no T dataset is built before that. `journey_custom_map` is
the preferred read table once events exist (UInt types, `server_date Date`).
