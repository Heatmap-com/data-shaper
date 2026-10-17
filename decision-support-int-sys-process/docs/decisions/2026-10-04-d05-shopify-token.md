# D-05: Shopify Admin access (plan §12 P0 row 5; Q1)

**Answer (operator):** not yet answered.

**Decision (Q1 default):** every S-code requirement is `missing` with
reason `no_token`; cards that need them are `conditional` naming the
instrumentation task. The `shopify-admin` ingest adapter is still built in
Phase 7 behind `ae_source_connection.status`, so a token only flips status.
Requested scopes when granted (§9.5): `read_orders`, `read_all_orders`,
`read_products`, `read_inventory`, `read_customers`, `read_returns`,
`read_fulfillments`, `read_shopify_payments_disputes`, `read_discounts`,
`read_shipping`, `read_themes`, `read_markets`, `read_locations` — all
read-only. First pull backfills 120 days.
