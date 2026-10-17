CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_schema_version
(
    schema_version UInt32,
    applied_at     DateTime64(3),
    applied_by     String,
    git_sha        String,
    notes          String
)
ENGINE = MergeTree
ORDER BY (schema_version, applied_at);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_batch
(
    batch_id                     UUID,
    created_at                   DateTime64(3),
    window_start                 Date,
    window_end                   Date,
    window_days                  UInt16,
    site_source                  LowCardinality(String),
    qualifier                    LowCardinality(String),
    page_selector                LowCardinality(String),
    max_pages_per_site           UInt16,
    catalogs                     Array(LowCardinality(String)),
    catalog_version              String,
    requirement_registry_version String,
    taxonomy_version             String,
    standards                    String,                  
    status                       LowCardinality(String),  
    sites_queued                 UInt32,
    sites_analyzed               UInt32,
    sites_skipped                UInt32,
    sites_failed                 UInt32,
    pages_analyzed               UInt32,
    metadata                     String,
    generated_at                 DateTime64(3),
    profile                      LowCardinality(String) DEFAULT '',
    subject_type                 LowCardinality(String) DEFAULT ''
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY batch_id;

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_site_queue
(
    batch_id       UUID,
    idsite         UInt32,
    site_name      String,
    status         LowCardinality(String),  
                                            
    reason         String,
    claim_token    String,
    pages_selected UInt16,
    pages_analyzed UInt16,
    entry_sessions UInt64,
    orders         UInt64,
    revenue        Float64,
    generated_at   DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (batch_id, idsite);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_page_target
(
    batch_id         UUID,
    idsite           UInt32,
    idsitehsr        UInt64,
    url              String,
    page_title       String,
    page_type        LowCardinality(String),
    template_family  LowCardinality(String),
    role             LowCardinality(String),  
    selection_reason String,
    entry_sessions   UInt64,
    pageview_hits    UInt64,
    orders           UInt64,
    revenue          Float64,
    status           LowCardinality(String),  
    reason           String,
    generated_at     DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (batch_id, idsite, idsitehsr);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_requirement
(
    registry_version String,
    requirement_key  LowCardinality(String),  
    domain           LowCardinality(String),  
    title            String,
    source_layer     LowCardinality(String),  
    mechanism        String,
    dataset_ids      Array(LowCardinality(String)),
    grain            String,
    human_required   UInt8,
    generated_at     DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (registry_version, requirement_key);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_strategy_catalog
(
    catalog_version  String,
    catalog_id       LowCardinality(String),  
    strategy_id      LowCardinality(String),  
    family           LowCardinality(String),
    name             String,
    scope            LowCardinality(String),  
    surface          LowCardinality(String),
    tools            Array(LowCardinality(String)),
    requirement_keys Array(LowCardinality(String)),
    composite_of     Array(String),
    alias_of         String,                  
    spec             String,                  
    source_ref       String,                  
    generated_at     DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (catalog_version, catalog_id, strategy_id);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_strategy_crosswalk
(
    catalog_version String,
    intent_id       LowCardinality(String),  
    catalog_id      LowCardinality(String),
    strategy_id     LowCardinality(String),
    relation        LowCardinality(String),  
    generated_at    DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (catalog_version, intent_id, catalog_id, strategy_id);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_screen_rule
(
    catalog_version String,
    catalog_id      LowCardinality(String),
    rule_id         LowCardinality(String),  
    kind            LowCardinality(String),  
    applies_to      Array(String),           
    disposition     LowCardinality(String),  
    spec            String,                  
    source_ref      String,
    generated_at    DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (catalog_version, catalog_id, rule_id);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_page_descriptor
(
    idsite             UInt32,
    template_key       String,                  
    device_class       LowCardinality(String),  
    field_path         LowCardinality(String),  
    value_json         String,                  
    provenance         LowCardinality(String),  
    confidence         LowCardinality(String),  
    human_confirmed_by String,
    owner              String,
    captured_at        DateTime64(3),
    expires_at         DateTime64(3),
    invalidated_by     String,                  
    descriptor_version UInt32,
    generated_at       DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, template_key, device_class, field_path);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_store_descriptor
(
    idsite             UInt32,
    field_path         LowCardinality(String),  
    value_json         String,
    provenance         LowCardinality(String),
    confidence         LowCardinality(String),
    human_confirmed_by String,
    owner              String,
    captured_at        DateTime64(3),
    expires_at         DateTime64(3),
    invalidated_by     String,
    descriptor_version UInt32,
    generated_at       DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, field_path);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_tool_registry
(
    idsite                 UInt32,
    tool                   LowCardinality(String),  
    vendor                 String,
    parent_company         String,
    installed              UInt8,
    modules                Array(LowCardinality(String)),
    plan_tier              String,
    pricing_basis          String,
    surfaces_owned         Array(LowCardinality(String)),
    identity_key           String,
    revenue_join_class     LowCardinality(String),
    event_taxonomy_status  LowCardinality(String),
    api_status             LowCardinality(String),
    detection_sources      Array(LowCardinality(String)),
    detection_confidence   LowCardinality(String),
    verified_by_walk_at    Nullable(DateTime64(3)),
    provenance             LowCardinality(String),
    captured_at            DateTime64(3),
    expires_at             DateTime64(3),
    note                   String,
    generated_at           DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, tool);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_change_log
(
    idsite       UInt32,
    change_id    String,                  
    change_kind  LowCardinality(String),  
                                          
                                          
    effective_at DateTime64(3),
    detected_at  DateTime64(3),
    source       LowCardinality(String),  
    subject      String,                  
    detail       String,                  
    generated_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, effective_at, change_id);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_source_connection
(
    idsite          UInt32,
    source          LowCardinality(String),  
    status          LowCardinality(String),  
    scopes          Array(String),
    last_success_at Nullable(DateTime64(3)),
    last_error      String,                  
    generated_at    DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, source);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_ingest_run
(
    run_id       UUID,
    idsite       UInt32,
    source       LowCardinality(String),
    object_type  LowCardinality(String),
    window_start DateTime64(3),
    window_end   DateTime64(3),
    cursor       String,
    rows_written UInt64,
    status       LowCardinality(String),  
    error        String,
    started_at   DateTime64(3),
    finished_at  DateTime64(3)
)
ENGINE = MergeTree
ORDER BY (idsite, source, object_type, started_at);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_capture_queue
(
    idsite         UInt32,
    idsitehsr      UInt64,
    url            String,
    page_type      LowCardinality(String),
    device_classes Array(LowCardinality(String)),  
    want           Array(LowCardinality(String)),  
    status         LowCardinality(String),         
    reason         String,
    requested_on   Date,
    claim_token    String,
    generated_at   DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, idsitehsr);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_page_capture
(
    idsite           UInt32,
    idsitehsr        UInt64,
    capture_id       UUID,
    url              String,
    status           LowCardinality(String),  
    taxonomy_version String,
    captured_on      Date,
    coverage         String,                  
    has_render       UInt8,
    has_saliency     UInt8,
    generated_at     DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, idsitehsr);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_element_binding
(
    idsite             UInt32,
    idsitehsr          UInt64,
    selector           String,
    element_class      LowCardinality(String),
    element_role       LowCardinality(String),
    name               String,
    template_family    LowCardinality(String),
    position_index     Int32,                   
    section_id         String,
    naming_provenance  LowCardinality(String),  
    ai_confidence      Float32,
    human_confirmed_by String,
    rollup_grain       LowCardinality(String),  
    attention_enrolled UInt8,
    taxonomy_version   String,
    named_on           Date,
    generated_at       DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, idsitehsr, selector);

-- Roswell audit naming matrix. Site-level, date-ranged, regex match.
-- Separate from ae_element_binding, which stays an exact selector per page.
CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_audit_matrix
(
    idsite          UInt32,
    template        LowCardinality(String),
    element_class   LowCardinality(String),
    element_name    String,
    selector_match  String,
    position_index  Int32,
    valid_from      Date,
    valid_to        Date,
    absent          UInt8,
    generated_at    DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, template, element_class, selector_match);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_page_render
(
    idsite           UInt32,
    idsitehsr        UInt64,
    device_class     LowCardinality(String),
    capture_id       UUID,
    viewport_w       UInt16,
    viewport_h       UInt16,
    page_height_px   UInt32,
    fold_px          UInt32,
    screenshot_uri   String,                  
    content_hash     String,
    dom_hash         String,
    section_order    Array(String),
    rendered_at      DateTime64(3),
    renderer_version String,
    generated_at     DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, idsitehsr, device_class);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_render_node
(
    idsite            UInt32,
    idsitehsr         UInt64,
    device_class      LowCardinality(String),
    capture_id        UUID,
    node_id           String,
    node_kind         LowCardinality(String),  
    selector          String,
    parent_section_id String,
    dom_order         UInt32,
    x                 Int32,
    y                 Int32,
    w                 UInt32,
    h                 UInt32,
    section_type      LowCardinality(String),
    visual_class      LowCardinality(String),  
    image_type        LowCardinality(String),  
    is_control        UInt8,
    looks_clickable   UInt8,
    is_sticky         UInt8,
    word_count        UInt32,
    in_first_viewport UInt8,
    saliency_share    Nullable(Float32),
    saliency_quartile Nullable(UInt8),
    saliency_model    String,
    generated_at      DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, idsitehsr, device_class, node_id);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_shop_state
(
    idsite       UInt32,
    kind         LowCardinality(String),  
                                          
    snapshot_at  DateTime64(3),
    state_hash   String,
    payload      String,                  
    ingested_at  DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (idsite, kind, snapshot_at);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_order
(
    idsite               UInt32,
    order_id             String,           
    order_name           String,           
    created_at           DateTime64(3),
    processed_at         DateTime64(3),
    cancelled_at         Nullable(DateTime64(3)),
    customer_key         String,
    customer_order_index UInt32,           
    source_name          LowCardinality(String),
    landing_site         String,
    gateway_names        Array(LowCardinality(String)),
    payment_bucket       LowCardinality(String),  
                                                  
    processor_mode       LowCardinality(String),  
    presentment_currency LowCardinality(String),
    has_duties           UInt8,
    discount_codes       Array(String),
    tags                 Array(String),
    subtotal             Float64,
    total                Float64,
    shipping_charged     Float64,
    total_refunded       Float64,
    financial_status     LowCardinality(String),
    fulfillment_status   LowCardinality(String),
    country              LowCardinality(String),
    is_subscription      UInt8,
    pos_location_id      String,
    ingested_at          DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (idsite, order_id, created_at);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_order_line
(
    idsite            UInt32,
    order_id          String,
    line_id           String,
    created_at        DateTime64(3),          
    product_id        String,
    variant_id        String,
    sku               String,
    quantity          UInt32,
    price             Float64,
    discount          Float64,
    refunded_quantity UInt32,
    selling_plan_id   String,
    offer_tool        LowCardinality(String), 
    offer_id          String,
    is_protection     UInt8,
    ingested_at       DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (idsite, order_id, line_id, created_at);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_refund
(
    idsite      UInt32,
    refund_id   String,
    order_id    String,
    created_at  DateTime64(3),
    amount      Float64,
    lines       String,                    
    ingested_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (idsite, refund_id, created_at);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_customer
(
    idsite                UInt32,
    customer_key          String,
    first_order_at        Nullable(DateTime64(3)),
    orders_count          UInt32,
    total_spent           Float64,
    returns_count         UInt32,
    has_account           UInt8,
    email_marketing_state LowCardinality(String),  
    sms_marketing_state   LowCardinality(String),
    tags                  Array(String),
    ingested_at           DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (idsite, customer_key);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_product_variant
(
    idsite        UInt32,
    variant_id    String,
    product_id    String,
    sku           String,
    product_type  LowCardinality(String),
    vendor        String,
    collections   Array(String),
    tags          Array(String),
    options       String,                  
    sibling_group String,                  
    price         Float64,
    compare_at    Nullable(Float64),
    unit_cost     Nullable(Float64),
    status        LowCardinality(String),
    created_at    DateTime64(3),
    ingested_at   DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (idsite, variant_id);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_inventory_level
(
    idsite        UInt32,
    snapshot_date Date,
    variant_id    String,
    location_id   String,
    location_type LowCardinality(String),  
    available     Int32,
    ingested_at   DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(snapshot_date)
ORDER BY (idsite, snapshot_date, variant_id, location_id);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_fulfillment
(
    idsite          UInt32,
    fulfillment_id  String,
    order_id        String,
    created_at      DateTime64(3),
    carrier         LowCardinality(String),
    tracking_key    String,                  
    status          LowCardinality(String),
    status_timeline String,                  
    delivered_at    Nullable(DateTime64(3)),
    ingested_at     DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (idsite, fulfillment_id, created_at);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_dispute
(
    idsite        UInt32,
    source        LowCardinality(String),  
    dispute_id    String,
    order_id      String,
    kind          LowCardinality(String),  
    reason        LowCardinality(String),
    status        LowCardinality(String),
    outcome       LowCardinality(String),  
    amount        Float64,
    represent_cost Nullable(Float64),
    opened_at     DateTime64(3),
    resolved_at   Nullable(DateTime64(3)),
    ingested_at   DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(opened_at)
ORDER BY (idsite, source, dispute_id, opened_at);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_abandoned_checkout
(
    idsite             UInt32,
    checkout_id        String,
    created_at         DateTime64(3),
    value              Float64,
    customer_key       String,
    has_email          UInt8,
    has_phone          UInt8,
    completed_order_id String,
    ingested_at        DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (idsite, checkout_id, created_at);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_subscription_contract
(
    idsite          UInt32,
    contract_id     String,
    app             LowCardinality(String),
    customer_key    String,
    origin_order_id String,
    selling_plan    String,
    status          LowCardinality(String),
    created_at      DateTime64(3),
    cancelled_at    Nullable(DateTime64(3)),
    next_billing_at Nullable(DateTime64(3)),
    ingested_at     DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (idsite, contract_id, created_at);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_store_credit_txn
(
    idsite      UInt32,
    source      LowCardinality(String),  
    txn_id      String,
    account_key String,
    kind        LowCardinality(String),  
    origin      LowCardinality(String),  
    amount      Float64,
    currency    LowCardinality(String),
    order_id    String,                  
    request_id  String,                  
    created_at  DateTime64(3),
    ingested_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (idsite, source, txn_id, created_at);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_tool_event
(
    idsite       UInt32,
    tool         LowCardinality(String),
    event_name   LowCardinality(String),  
    event_id     String,
    occurred_at  DateTime64(3),
    surface      LowCardinality(String),
    placement    LowCardinality(String),
    object_type  LowCardinality(String),
    object_id    String,
    order_id     String,
    customer_key String,
    idvisit      Nullable(UInt64),        
    props        String,                  
    ingested_at  DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (idsite, tool, event_name, occurred_at, event_id);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_tool_object
(
    idsite      UInt32,
    tool        LowCardinality(String),
    object_type LowCardinality(String),  
    object_id   String,
    updated_at  DateTime64(3),
    status      LowCardinality(String),
    config_hash String,                  
    payload     String,                  
    ingested_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (idsite, tool, object_type, object_id);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_return_request
(
    idsite            UInt32,
    source            LowCardinality(String),  
    request_id        String,
    order_id          String,
    customer_key      String,
    created_at        DateTime64(3),
    closed_at         Nullable(DateTime64(3)),
    status            LowCardinality(String),  
    channel           LowCardinality(String),  
    device            LowCardinality(String),
    reason_raw        String,
    reason_canonical  LowCardinality(String),  
    resolution        LowCardinality(String),  
    exchange_type     LowCardinality(String),  
    exchange_order_id String,
    bonus_offered     Float64,
    bonus_taken       Float64,
    credit_issued     Float64,
    refund_amount     Float64,
    item_value        Float64,
    label_cost        Nullable(Float64),
    label_paid_by     LowCardinality(String),  
    fraud_score       LowCardinality(String),  
    fraud_signals     Array(LowCardinality(String)),  
    prior_request_id  String,                  
    disposition       LowCardinality(String),  
    arm               String,
    flow_variant      String,
    agent_used        UInt8,
    ingested_at       DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (idsite, source, request_id, created_at);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_return_item
(
    idsite                 UInt32,
    source                 LowCardinality(String),
    request_id             String,
    created_at             DateTime64(3),
    line_id                String,
    variant_id             String,
    sku                    String,
    quantity               UInt32,
    value                  Float64,
    reason_raw             String,
    reason_canonical       LowCardinality(String),
    resolution             LowCardinality(String),
    replacement_variant_id String,
    ingested_at            DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (idsite, source, request_id, line_id, created_at);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_message
(
    idsite              UInt32,
    tool                LowCardinality(String),
    flow_id             String,
    message_id          String,
    recipient_key       String,
    channel             LowCardinality(String),  
    variant             String,
    sent_at             DateTime64(3),
    opened_at           Nullable(DateTime64(3)),
    clicked_at          Nullable(DateTime64(3)),
    unsubscribed_at     Nullable(DateTime64(3)),
    attributed_order_id String,
    offer_ref           String,
    ingested_at         DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(sent_at)
ORDER BY (idsite, tool, sent_at, message_id, recipient_key);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_ticket
(
    idsite       UInt32,
    tool         LowCardinality(String),
    ticket_id    String,
    created_at   DateTime64(3),
    channel      LowCardinality(String),
    intent       LowCardinality(String),  
    order_id     String,
    customer_key String,
    actions      Array(LowCardinality(String)),  
    resolved_at  Nullable(DateTime64(3)),
    csat         Nullable(Float32),
    ingested_at  DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (idsite, tool, ticket_id, created_at);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_review
(
    idsite        UInt32,
    tool          LowCardinality(String),
    review_id     String,
    product_id    String,
    created_at    DateTime64(3),
    rating        UInt8,
    title         String,
    body          String,                  
    attributes    String,                  
    incentivized  UInt8,
    verified      UInt8,
    helpful_votes UInt32,
    themes        Array(LowCardinality(String)),
    theme_model   String,
    ingested_at   DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (idsite, tool, review_id, created_at);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_ad_creative
(
    idsite          UInt32,
    platform        LowCardinality(String),  
    ad_id           String,
    campaign_id     String,
    adset_id        String,
    utm_source      String,
    utm_campaign    String,
    utm_content     String,
    destination_url String,
    product_refs    Array(String),
    offer_text      String,
    claim_text      String,
    has_code        UInt8,
    creator         String,
    angle           LowCardinality(String),
    temperature     LowCardinality(String),  
    offer_led       UInt8,
    provenance      LowCardinality(String),  
    captured_at     DateTime64(3),
    ingested_at     DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (idsite, platform, ad_id);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_search_query
(
    idsite        UInt32,
    date          Date,
    page_url      String,
    query         String,
    clicks        UInt32,
    impressions   UInt32,
    position      Float32,
    is_comparison UInt8,
    ingested_at   DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(date)
ORDER BY (idsite, date, page_url, query);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_page_perf
(
    idsite      UInt32,
    date        Date,
    url         String,
    device      LowCardinality(String),
    source      LowCardinality(String),  
    lcp_ms      Nullable(UInt32),
    inp_ms      Nullable(UInt32),
    cls         Nullable(Float32),
    ttfb_ms     Nullable(UInt32),
    ingested_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(date)
ORDER BY (idsite, date, url, device, source);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_src_js_error
(
    idsite        UInt32,
    date          Date,
    url           String,
    browser       LowCardinality(String),
    selector      String,
    message_hash  String,
    events        UInt32,
    sessions      UInt32,
    p95_handler_ms Nullable(UInt32),
    ingested_at   DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(date)
ORDER BY (idsite, date, url, browser, selector, message_hash);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_experiment
(
    idsite        UInt32,
    experiment_id String,
    source        LowCardinality(String),  
    partner       String,
    name          String,
    strategy_refs Array(String),           
    unit          LowCardinality(String),  
    arms          String,                  
    segment_scope String,
    test_code     LowCardinality(String),  
    mde           Nullable(Float64),
    analysis_plan LowCardinality(String),  
    started_at    Nullable(DateTime64(3)),
    ended_at      Nullable(DateTime64(3)),
    status        LowCardinality(String),  
    result        String,                  
    generated_at  DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, experiment_id);

-- One experiment's descriptor. experiment_key is `{partner}:{partner
-- experiment id}`, or `{partner}:name:{slug}` when the tag carries no id.
-- provenance `operator` is the governance import (hypothesis, pages,
-- elements, arm aliases, dates). provenance `observed` is written by the
-- experiment-analysis dataset: the inferred descriptor with the operator
-- row merged over it, plus the lifecycle. A run never writes `operator`.
-- arms is JSON [{arm, label, is_control, allocation, aliases, visits,
-- stray}]. elements is JSON [{selector, idsitehsr?, arm?, element_class?,
-- section?}]. zones is JSON [{section, idsitehsr?, role}]: rollup sections
-- (section_level_data.section_name) under test (role treated) or watched
-- (role guardrail). scope is site, template, page, redirect, script, or
-- unknown.
CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_experiment_descriptor
(
    idsite                UInt32,
    experiment_key        String,
    provenance            LowCardinality(String),
    partner               LowCardinality(String),
    partner_experiment_id String,
    name                  String,
    hypothesis            String,
    description           String,
    kind                  LowCardinality(String),
    scope                 LowCardinality(String),
    scope_source          LowCardinality(String),
    device_scope          LowCardinality(String),
    templates             Array(String),
    pages                 Array(UInt64),
    elements              String,
    zones                 String,
    arms                  String,
    declared_start        Nullable(Date),
    declared_end          Nullable(Date),
    observed_start        Nullable(Date),
    observed_end          Nullable(Date),
    last_seen             Nullable(Date),
    peak_daily_visits     UInt64,
    assigned_visits       UInt64,
    status                LowCardinality(String),
    status_as_of          Nullable(Date),
    metrics               String,
    generated_at          DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, experiment_key, provenance);

-- Daily experiment readings. One row is one experiment, arm, basis, page,
-- section, selector, viewport_type, strategy value, and day. basis
-- `assigned` is every tagged visit in the arm; `exposed` is the visits that
-- viewed the page or template under test; `multi_arm` is visits tagged in
-- two arms of the experiment, kept out of every other basis, with arm ''.
-- idsitehsr 0 with section and selector '' is the experiment total; a page
-- row has the page.
-- Rollup rows read section_level_data, which captures a sample of visits:
-- `section_captured` (section '') is the arm's visits with any section
-- event on the experiment's pages, the base for every section rate;
-- `section_seen` / `section_clicked` are the visits that saw / clicked in
-- that section. The section table collapses repeat clicks, so section rows
-- count visits and clicks is 0.
-- Element rows (basis `clicked`) read every click: sessions is the visits
-- that clicked the selector, clicks their clicks, section the innermost
-- section the selector sits in ('' when none). Selectors have Shopify's
-- template--{id}__ / sections--{id}__ numbers removed so a theme publish or
-- a theme arm keeps one key.
-- day is the visit's first assignment day and day_index counts from the
-- experiment's start. Strategies follow ae_trend_row: summing two
-- strategies, or viewport `all` with the devices, double-counts.
CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_experiment_row
(
    batch_id       UUID,
    idsite         UInt32,
    experiment_key String,
    arm            String,
    is_control     UInt8,
    scope          LowCardinality(String),
    basis          LowCardinality(String),
    idsitehsr      UInt64,
    section        String,
    selector       String,
    element_class  LowCardinality(String),
    viewport_type  LowCardinality(String),
    segment        LowCardinality(String),
    segment_value  LowCardinality(String),
    day            Date,
    day_index      UInt16,
    sessions       UInt64,
    buyers         UInt64,
    orders         UInt64,
    revenue        Float64,
    clicks         UInt64,
    progressed     UInt64,
    metrics        String,
    generated_at   DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
PARTITION BY toYYYYMM(day)
ORDER BY (idsite, experiment_key, arm, basis, idsitehsr, section, selector, viewport_type, segment, segment_value, day);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_review_verdict
(
    idsite         UInt32,
    verdict_id     String,
    subject_kind   LowCardinality(String),  
    subject_ref    String,
    verdict_kind   LowCardinality(String),  
                                            
    population     String,
    sample_size    UInt32,
    agreement_rate Nullable(Float32),
    outcome        LowCardinality(String),  
    evidence_uri   String,
    reviewed_by    String,
    reviewed_at    DateTime64(3),
    expires_at     Nullable(DateTime64(3)),
    generated_at   DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, subject_kind, subject_ref, verdict_kind, verdict_id);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_dataset_row
(
    batch_id          UUID,
    idsite            UInt32,
    idsitehsr         UInt64,                  
    scope             LowCardinality(String),  
    dataset_id        LowCardinality(String),
    bot_filter        LowCardinality(String),  
    dim_week          Nullable(Date),
    dim_device        LowCardinality(String),
    dim_source        LowCardinality(String),
    dim_returning     LowCardinality(String),
    dim_selector      String,
    dim_element_class LowCardinality(String),
    dim_surface       LowCardinality(String),
    dim_tool          LowCardinality(String),
    dim_extra         String,                  
    metrics           String,                  
    row_key           String,
    generated_at      DateTime64(3),
    subject_type      LowCardinality(String) DEFAULT 'page',
    subject_key       String DEFAULT ''
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (batch_id, idsite, idsitehsr, dataset_id, row_key);

-- One row per finished dataset for a batch, site, and page. Written after
-- that dataset's rows are inserted. A restarted run loads these and does
-- not collect the dataset again. idsitehsr 0 is a site-scope dataset.
-- notes is the dataset's notes object, JSON, so a resumed run can hand
-- the same notes to later datasets. A later generated_at replaces.
CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_analysis_checkpoint
(
    batch_id     UUID,
    idsite       UInt32,
    idsitehsr    UInt64,
    dataset_id   LowCardinality(String),
    scope        LowCardinality(String),
    row_count    UInt64,
    notes        String,
    generated_at DateTime64(3),
    subject_type LowCardinality(String) DEFAULT 'page',
    subject_key  String DEFAULT ''
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (batch_id, idsite, idsitehsr, dataset_id);

-- One grain for week-over-week trends. row_type picks the subject
-- (journey, page, element, experiment). segment / segment_value is one
-- segmentation strategy, and the values of a strategy partition the
-- sessions. A facet reads one strategy. Summing every segment_value
-- across strategies double-counts. viewport_type is the device cut
-- (all, desktop, tablet, mobile, and unknown when a visit has no
-- device). It is in the sort key so a facet can filter one device
-- after the subject. Summing viewport_type = all together with the
-- device rows double-counts. idsitehsr is 0 when the subject is not a
-- page. The latest generated_at replaces a week.
CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_trend_row
(
    batch_id       UUID,
    idsite         UInt32,
    idsitehsr      UInt64,
    row_type       LowCardinality(String),
    row_key        LowCardinality(String),
    row_key_1      String,
    row_key_2      String,
    viewport_type  LowCardinality(String),
    segment        LowCardinality(String),
    segment_value  LowCardinality(String),
    week           Date,
    sessions       UInt64,
    buyers         UInt64,
    orders         UInt64,
    revenue        Float64,
    clicks         UInt64,
    progressed     UInt64,
    metrics        String,
    generated_at   DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, row_type, row_key, row_key_1, row_key_2, viewport_type, segment, segment_value, week, idsitehsr);

-- Selectors a site has asked to trend, one row per page. A later
-- generated_at replaces that page. status is active or paused. An
-- empty trend_selectors array writes no element rows.
CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_trend_selector
(
    idsite           UInt32,
    idsitehsr        UInt64,
    trend_selectors  Array(String),
    status           LowCardinality(String),
    generated_at     DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, idsitehsr);

-- Week-over-week trend of session-tag values, site-wide. One row is one
-- tag key and value, one Monday, one viewport_type, one strategy. The
-- values of one tag_key partition the kept sessions: `(none)` is a visit
-- without the key and `other` is a value outside the selected list.
-- Strategies are those of ae_trend_row plus return_intent (new,
-- returning_unseen, prior_buyer, open_cart, prior_high_intent,
-- prior_browse). Summing two tag keys, two strategies, or `all` with the
-- devices double-counts. The latest generated_at replaces a week.
CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_session_tag_trend
(
    batch_id       UUID,
    idsite         UInt32,
    tag_key        LowCardinality(String),
    tag_value      String,
    viewport_type  LowCardinality(String),
    segment        LowCardinality(String),
    segment_value  LowCardinality(String),
    week           Date,
    sessions       UInt64,
    buyers         UInt64,
    orders         UInt64,
    revenue        Float64,
    progressed     UInt64,
    metrics        String,
    generated_at   DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, tag_key, tag_value, viewport_type, segment, segment_value, week);

-- Which session-tag keys a site trends and why, one row per key seen in
-- the window. status is selected or rejected. trend_values are the values
-- that get their own trend row. rps_z / aov_z are the spread tests as z
-- scores; rps_spread / aov_spread are the weighted spread of the value
-- means over the key mean. The latest batch_id for a site is the
-- selection in force.
CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_session_tag_selection
(
    batch_id         UUID,
    idsite           UInt32,
    tag_key          LowCardinality(String),
    adapter_id       LowCardinality(String),
    family           LowCardinality(String),
    status           LowCardinality(String),
    reason           String,
    window_start     Date,
    window_end       Date,
    tagged_sessions  UInt64,
    distinct_values  UInt64,
    rps_z            Nullable(Float64),
    rps_spread       Nullable(Float64),
    aov_z            Nullable(Float64),
    aov_spread       Nullable(Float64),
    trend_values     Array(String),
    metrics          String,
    generated_at     DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, tag_key);

-- One build of a site's traffic-exclusion model. model_id is part of the
-- key, so a later build is a new version and the earlier one stays.
-- rule_id dead_session is the one-page, zero-click, zero-scroll class.
-- rule_id viewport_pattern is a square viewport, or a viewport wider than
-- the site's phone maximum on a phone device code, with zero orders and
-- zero clicks. disposition exclude is applied; watch is large but under
-- the very-large bar. constants_json is the descriptor (or the default)
-- that defined large and very large for this build.
CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_traffic_exclusion_model
(
    model_id         UUID,
    idsite           UInt32,
    adapter_id       LowCardinality(String),
    window_start     Date,
    window_end       Date,
    rule_id          LowCardinality(String),
    pattern_key      String,
    disposition      LowCardinality(String),
    reason           String,
    sessions         UInt64,
    orders           UInt64,
    clicks           UInt64,
    revenue          Float64,
    share            Float64,
    constants_json   String,
    detail_json      String,
    generated_at     DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, model_id, rule_id, pattern_key);

-- Trigger registry. Predicate thresholds live in `predicate` (JSON).
-- A threshold change writes a new version; hits keep the version that
-- produced them. idsite 0 is the shipped default. A row for a real
-- idsite overrides that key for the site, so a threshold can change
-- without a deploy. Names follow the warehouse: idsite, not site_id.
-- ORDER BY is the definition identity, so a rerun replaces that version.
CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_trigger_definition
(
    idsite         UInt32,
    trigger_key    LowCardinality(String),
    name           String,
    level          LowCardinality(String),
    version        UInt32,
    predicate      String,
    active         UInt8,
    generated_at   DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, trigger_key, version);

-- One version of one segmentation for one site. idsite 0 is the shipped
-- default. stamp is the canonical resolved definition; a different stamp
-- is a new version. `values` is the closed value list, in order. The
-- latest generated_at replaces a version row. Reference data, like
-- ae_trigger_definition: rows carry the version they were written under.
CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_segmentation_definition
(
    idsite        UInt32,
    segmentation  LowCardinality(String),
    version       UInt32,
    kind          LowCardinality(String),
    stamp         String,
    definition    String,
    `values`      Array(String),
    generated_at  DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, segmentation, version);

-- One qualifying session, or one qualifying visitor on the day it
-- qualified. config_id is the visitor key (the repeating UUID on
-- udp_hsrce_visits). idvisit is the session, kept so a dimension that
-- is not stored here can be joined from the visit. The order prefix
-- is (idsite, trigger_key, server_date); idvisit and config_id follow
-- so two hits on the same day stay distinct under ReplacingMergeTree.
CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_trigger_hit
(
    idsite            UInt32,
    trigger_key       LowCardinality(String),
    server_date       Date,
    trigger_version   UInt32,
    idvisit           UInt64,
    config_id         String,
    level             LowCardinality(String),
    device            LowCardinality(String),
    channel           LowCardinality(String),
    source            String,
    medium            String,
    returning         LowCardinality(String),
    country           LowCardinality(String),
    landing_page      String,
    entry_template    LowCardinality(String),
    generated_at      DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, trigger_key, server_date, idvisit, config_id);

-- Outcome of one hit over its chain window. final = 0 until the
-- window has closed; a later batch day replaces the open row. The
-- session dims are the hit's, so a chain reads by device or channel
-- without a join back to ae_trigger_hit.
CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_trigger_chain
(
    idsite                    UInt32,
    trigger_key               LowCardinality(String),
    server_date               Date,
    trigger_version           UInt32,
    idvisit                   UInt64,
    config_id                 String,
    level                     LowCardinality(String) DEFAULT '',
    device                    LowCardinality(String) DEFAULT '',
    channel                   LowCardinality(String) DEFAULT '',
    source                    String DEFAULT '',
    medium                    String DEFAULT '',
    returning                 LowCardinality(String) DEFAULT '',
    country                   LowCardinality(String) DEFAULT '',
    landing_page              String DEFAULT '',
    entry_template            LowCardinality(String) DEFAULT '',
    returned                  UInt8,
    sessions_until_return     UInt32,
    sessions_until_purchase   UInt32,
    purchased                 UInt8,
    revenue                   Float64,
    seconds_to_purchase       UInt32,
    recovered                 UInt8,
    window_days               UInt16,
    window_closes             Date,
    final                     UInt8,
    generated_at              DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, trigger_key, server_date, idvisit, config_id);

-- The day scan's stored days (src/adapters/day-store/clickhouse.js): what
-- one site's day read from the warehouse, so a later run replays it. An
-- entry is its parts of one generated_at; a read takes the latest.
CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_scan_day
(
    idsite        UInt32,
    kind          LowCardinality(String),
    key           String,
    server_date   Date,
    version       UInt16,
    final         UInt8,
    shape         String,
    part          UInt16,
    parts         UInt16,
    rows          UInt32,
    payload       String CODEC(ZSTD(3)),
    generated_at  DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (idsite, kind, key, server_date, part)
TTL server_date + INTERVAL 400 DAY;

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_requirement_status
(
    batch_id        UUID,
    idsite          UInt32,
    idsitehsr       UInt64,                  
    requirement_key LowCardinality(String),
    status          LowCardinality(String),  
    dataset_id      LowCardinality(String),
    source          LowCardinality(String),
    row_count       UInt64,
    detail          String,                  
    generated_at    DateTime64(3),
    subject_type    LowCardinality(String) DEFAULT 'page',
    subject_key     String DEFAULT ''
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (batch_id, idsite, idsitehsr, requirement_key);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_page_analysis
(
    batch_id              UUID,
    idsite                UInt32,
    idsitehsr             UInt64,
    url                   String,
    page_title            String,
    page_type             LowCardinality(String),
    template_family       LowCardinality(String),
    role                  LowCardinality(String),
    window_start          Date,
    window_end            Date,
    entry_sessions        UInt64,
    orders                UInt32,
    revenue               Float64,
    rps                   Float64,
    cvr                   Float64,
    aov                   Float64,
    single_pageview_share Float64,
    scroll_reach_25       Float64,
    scroll_reach_70       Float64,
    desktop_rps           Float64,
    mobile_rps            Float64,
    mobile_to_desktop_rps Float64,
    bot_sessions_excluded UInt64,
    sessions_unfiltered   UInt64,
    orders_unfiltered     UInt32,
    descriptor_status     LowCardinality(String),  
    capture_status        LowCardinality(String),  
    requirements_available UInt16,
    requirements_missing  UInt16,
    cards_include         UInt16,
    cards_conditional     UInt16,
    cards_exclude         UInt16,
    cards_triggered       UInt16,
    cards_silent          UInt16,
    cards_below_floor     UInt16,
    cards_blocked         UInt16,
    status                LowCardinality(String),  
    metadata              String,
    generated_at          DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (batch_id, idsite, idsitehsr);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_site_analysis
(
    batch_id               UUID,
    idsite                 UInt32,
    window_start           Date,
    window_end             Date,
    sessions               UInt64,
    orders                 UInt32,
    revenue                Float64,
    rps                    Float64,
    cvr                    Float64,
    aov                    Float64,
    pp_eligible_share      Nullable(Float64),
    pp_rendered_share      Nullable(Float64),
    reconciliation_min     Nullable(Float64),
    descriptor_status      LowCardinality(String),
    sources_connected      Array(LowCardinality(String)),
    sources_missing        Array(LowCardinality(String)),
    tools_installed        Array(LowCardinality(String)),
    requirements_available UInt16,
    requirements_missing   UInt16,
    cards_include          UInt16,
    cards_conditional      UInt16,
    cards_exclude          UInt16,
    cards_triggered        UInt16,
    cards_silent           UInt16,
    cards_below_floor      UInt16,
    cards_blocked          UInt16,
    status                 LowCardinality(String),
    metadata               String,
    generated_at           DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (batch_id, idsite);

CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_strategy_card
(
    batch_id             UUID,
    idsite               UInt32,
    idsitehsr            UInt64,                  
    catalog_id           LowCardinality(String),
    strategy_id          LowCardinality(String),
    segment_key          String,                  
    scope                LowCardinality(String),
    surface              LowCardinality(String),
    tool                 LowCardinality(String),
    verdict              LowCardinality(String),  
    trigger_state        LowCardinality(String),  
    structural_state     LowCardinality(String),  
    gate_failed          LowCardinality(String),  
    blocking_rule        String,                  
    missing_requirements Array(LowCardinality(String)),
    trigger_evaluated    UInt8,
    triggered_rules      Array(String),
    observational_trigger String,                 
    floor_standard       LowCardinality(String),
    metric               String,
    value                Nullable(Float64),
    threshold            Nullable(Float64),
    confidence           LowCardinality(String),  
    confounds            String,                  
    attribution_label    LowCardinality(String),  
    test_code            LowCardinality(String),  
    kill_metric          String,
    guardrails           Array(String),
    impact_proxy         Nullable(Float64),
    score                Nullable(Float64),
    score_basis          LowCardinality(String),  
    effort_class         LowCardinality(String),
    owner                String,
    exclusion_reeval     String,                  
    card_json            String,                  
    generated_at         DateTime64(3),
    subject_type         LowCardinality(String) DEFAULT 'page',
    subject_key          String DEFAULT ''
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (batch_id, idsite, idsitehsr, catalog_id, strategy_id, segment_key);

-- One row per selected subject of any type: the subject-shaped
-- counterpart of ae_page_target. A page subject's subject_key is its
-- idsitehsr as a string; other types carry their prefixed key.
CREATE TABLE IF NOT EXISTS ${DATABASE}.ae_subject_target
(
    batch_id         UUID,
    idsite           UInt32,
    subject_type     LowCardinality(String),
    subject_key      String,
    label            String,
    dims             String,
    role             LowCardinality(String),
    selection_reason String,
    evidence         String,
    status           LowCardinality(String),
    reason           String,
    generated_at     DateTime64(3)
)
ENGINE = ReplacingMergeTree(generated_at)
ORDER BY (batch_id, idsite, subject_type, subject_key);

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_batch_current AS
SELECT * FROM ${DATABASE}.ae_batch FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_site_queue_current AS
SELECT * FROM ${DATABASE}.ae_site_queue FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_page_target_current AS
SELECT * FROM ${DATABASE}.ae_page_target FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_subject_target_current AS
SELECT * FROM ${DATABASE}.ae_subject_target FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_requirement_current AS
SELECT * FROM ${DATABASE}.ae_requirement FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_strategy_catalog_current AS
SELECT * FROM ${DATABASE}.ae_strategy_catalog FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_strategy_crosswalk_current AS
SELECT * FROM ${DATABASE}.ae_strategy_crosswalk FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_screen_rule_current AS
SELECT * FROM ${DATABASE}.ae_screen_rule FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_page_descriptor_current AS
SELECT * FROM ${DATABASE}.ae_page_descriptor FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_store_descriptor_current AS
SELECT * FROM ${DATABASE}.ae_store_descriptor FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_tool_registry_current AS
SELECT * FROM ${DATABASE}.ae_tool_registry FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_change_log_current AS
SELECT * FROM ${DATABASE}.ae_change_log FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_source_connection_current AS
SELECT * FROM ${DATABASE}.ae_source_connection FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_capture_queue_current AS
SELECT * FROM ${DATABASE}.ae_capture_queue FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_page_capture_current AS
SELECT * FROM ${DATABASE}.ae_page_capture FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_element_binding_current AS
SELECT * FROM ${DATABASE}.ae_element_binding FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_audit_matrix_current AS
SELECT * FROM ${DATABASE}.ae_audit_matrix FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_page_render_current AS
SELECT * FROM ${DATABASE}.ae_page_render FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_render_node_current AS
SELECT * FROM ${DATABASE}.ae_render_node FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_shop_state_current AS
SELECT * FROM ${DATABASE}.ae_src_shop_state FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_order_current AS
SELECT * FROM ${DATABASE}.ae_src_order FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_order_line_current AS
SELECT * FROM ${DATABASE}.ae_src_order_line FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_refund_current AS
SELECT * FROM ${DATABASE}.ae_src_refund FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_customer_current AS
SELECT * FROM ${DATABASE}.ae_src_customer FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_product_variant_current AS
SELECT * FROM ${DATABASE}.ae_src_product_variant FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_inventory_level_current AS
SELECT * FROM ${DATABASE}.ae_src_inventory_level FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_fulfillment_current AS
SELECT * FROM ${DATABASE}.ae_src_fulfillment FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_dispute_current AS
SELECT * FROM ${DATABASE}.ae_src_dispute FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_abandoned_checkout_current AS
SELECT * FROM ${DATABASE}.ae_src_abandoned_checkout FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_subscription_contract_current AS
SELECT * FROM ${DATABASE}.ae_src_subscription_contract FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_store_credit_txn_current AS
SELECT * FROM ${DATABASE}.ae_src_store_credit_txn FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_tool_event_current AS
SELECT * FROM ${DATABASE}.ae_src_tool_event FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_tool_object_current AS
SELECT * FROM ${DATABASE}.ae_src_tool_object FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_return_request_current AS
SELECT * FROM ${DATABASE}.ae_src_return_request FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_return_item_current AS
SELECT * FROM ${DATABASE}.ae_src_return_item FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_message_current AS
SELECT * FROM ${DATABASE}.ae_src_message FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_ticket_current AS
SELECT * FROM ${DATABASE}.ae_src_ticket FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_review_current AS
SELECT * FROM ${DATABASE}.ae_src_review FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_ad_creative_current AS
SELECT * FROM ${DATABASE}.ae_src_ad_creative FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_search_query_current AS
SELECT * FROM ${DATABASE}.ae_src_search_query FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_page_perf_current AS
SELECT * FROM ${DATABASE}.ae_src_page_perf FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_src_js_error_current AS
SELECT * FROM ${DATABASE}.ae_src_js_error FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_experiment_current AS
SELECT * FROM ${DATABASE}.ae_experiment FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_experiment_descriptor_current AS
SELECT * FROM ${DATABASE}.ae_experiment_descriptor FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_experiment_row_current AS
SELECT * FROM ${DATABASE}.ae_experiment_row FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_review_verdict_current AS
SELECT * FROM ${DATABASE}.ae_review_verdict FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_dataset_row_current AS
SELECT * FROM ${DATABASE}.ae_dataset_row FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_analysis_checkpoint_current AS
SELECT * FROM ${DATABASE}.ae_analysis_checkpoint FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_trend_row_current AS
SELECT * FROM ${DATABASE}.ae_trend_row FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_trend_selector_current AS
SELECT * FROM ${DATABASE}.ae_trend_selector FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_session_tag_trend_current AS
SELECT * FROM ${DATABASE}.ae_session_tag_trend FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_session_tag_selection_current AS
SELECT * FROM ${DATABASE}.ae_session_tag_selection FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_traffic_exclusion_model_current AS
SELECT * FROM ${DATABASE}.ae_traffic_exclusion_model FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_trigger_definition_current AS
SELECT * FROM ${DATABASE}.ae_trigger_definition FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_segmentation_definition_current AS
SELECT * FROM ${DATABASE}.ae_segmentation_definition FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_trigger_hit_current AS
SELECT * FROM ${DATABASE}.ae_trigger_hit FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_trigger_chain_current AS
SELECT * FROM ${DATABASE}.ae_trigger_chain FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_scan_day_current AS
SELECT * FROM ${DATABASE}.ae_scan_day FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_requirement_status_current AS
SELECT * FROM ${DATABASE}.ae_requirement_status FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_page_analysis_current AS
SELECT * FROM ${DATABASE}.ae_page_analysis FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_site_analysis_current AS
SELECT * FROM ${DATABASE}.ae_site_analysis FINAL;

CREATE OR REPLACE VIEW IF NOT EXISTS ${DATABASE}.ae_strategy_card_current AS
SELECT * FROM ${DATABASE}.ae_strategy_card FINAL;

