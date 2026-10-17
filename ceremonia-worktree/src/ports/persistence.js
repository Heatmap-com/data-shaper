/**
 * One batch is one window and one set of rules.
 *
 * @typedef {Object} BatchSpec
 * @property {string} batchId UUID
 * @property {string} windowStart YYYY-MM-DD
 * @property {string} windowEnd YYYY-MM-DD
 * @property {string} siteSource adapter id
 * @property {string} qualifier adapter id
 * @property {number} minSessions
 * @property {number} minOrders
 * @property {number} minShareOfHome
 * @property {object} [metadata] schema version, discovered adapter ids, column-check notes
 */

/**
 * @typedef {Object} QueueUpdate
 * @property {string} batchId
 * @property {number} idsite
 * @property {string} status
 * @property {number} [idsitehsr]
 * @property {string} [landingPageUrl]
 * @property {string} [pageType]
 * @property {number} [entrySessions]
 * @property {number} [orders]
 * @property {number} [revenue]
 * @property {string} [reason]
 */

/**
 * One row per qualified page per batch.
 *
 * @typedef {Object} AnalysisRecord
 * @property {string} batchId
 * @property {number} idsite
 * @property {number} idsitehsr
 * @property {string} landingPageUrl
 * @property {string} pageTitle
 * @property {string} pageType
 * @property {string} windowStart
 * @property {string} windowEnd
 * @property {number} entrySessions
 * @property {number} orders
 * @property {number} revenue
 * @property {number} rps
 * @property {number} singlePageviewShare
 * @property {number} scrollReach25
 * @property {number} scrollReach70
 * @property {number} desktopRps
 * @property {number} mobileRps
 * @property {number} mobileToDesktopRps
 * @property {number} botSessionsExcluded
 * @property {number} sessionsUnfiltered
 * @property {number} ordersUnfiltered
 * @property {number} strategiesTriggered
 * @property {number} strategiesBelowFloor
 * @property {number} strategiesBlocked
 * @property {number} strategiesSilent
 * @property {string} status 'analyzed'
 * @property {object} metadata qualifier evidence, column checks, campaign share, coverage, per-strategy records
 */

/**
 * @typedef {import('./dataset.js').DatasetRow} DatasetRow
 */

/**
 * The v1 persistence port, composed of its role ports.
 *
 * @typedef {{id: string} & import('./persistence/landing-page-store.js').LandingPageStore & import('./persistence/naming-queue.js').NamingQueue} PersistencePort
 */

/**
 * Schema-2 batch (ae_batch). One batch is one window, one catalog set and
 * one set of standards.
 *
 * @typedef {Object} AeBatchSpec
 * @property {string} batchId UUID
 * @property {string} windowStart YYYY-MM-DD
 * @property {string} windowEnd YYYY-MM-DD
 * @property {number} [windowDays] default 30
 * @property {string[]} [catalogs] catalog ids in play, e.g. ['LP', 'PO']
 * @property {object} [standards] floors and constants per catalog (§11)
 * @property {string} [siteSource] adapter id
 * @property {string} [qualifier] adapter id
 * @property {string} [pageSelector] adapter id
 * @property {string} [profile] execution profile id
 * @property {string} [subjectType] the profile's subject type
 * @property {number} [maxPagesPerSite] default 6
 * @property {string} [catalogVersion]
 * @property {string} [requirementRegistryVersion]
 * @property {string} [taxonomyVersion]
 * @property {string} [status] 'open' | 'running' | 'complete' | 'failed', default 'open'
 * @property {object} [metadata]
 */

/**
 * @typedef {Object} AeSiteUpdate
 * @property {string} batchId
 * @property {number} idsite
 * @property {string} [status] queued | claimed | selecting_pages | awaiting_descriptor | awaiting_capture | analyzing | analyzed | skipped_volume | skipped_no_page | failed
 * @property {string} [siteName]
 * @property {number} [pagesSelected]
 * @property {number} [pagesAnalyzed]
 * @property {number} [entrySessions]
 * @property {number} [orders]
 * @property {number} [revenue]
 * @property {string} [reason]
 */

/**
 * One selected page per site per batch (ae_page_target).
 *
 * @typedef {Object} AePageTarget
 * @property {number} idsitehsr
 * @property {string} url
 * @property {string} [pageTitle]
 * @property {string} [pageType]
 * @property {string} [templateFamily]
 * @property {string} [role] primary | sister | template_member | kind_member | tool_surface
 * @property {string} [selectionReason]
 * @property {number} [entrySessions]
 * @property {number} [pageviewHits]
 * @property {number} [orders]
 * @property {number} [revenue]
 * @property {string} [status] default 'selected'
 * @property {string} [reason]
 */

/**
 * @typedef {Object} AePageTargetUpdate
 * @property {string} batchId
 * @property {number} idsite
 * @property {number} idsitehsr
 * @property {string} [status] selected | awaiting_capture | analyzing | analyzed | skipped_volume | failed
 * @property {string} [reason]
 * @property {string} [url]
 * @property {string} [pageTitle]
 * @property {string} [pageType]
 * @property {string} [templateFamily]
 * @property {string} [role]
 * @property {string} [selectionReason]
 * @property {number} [entrySessions]
 * @property {number} [pageviewHits]
 * @property {number} [orders]
 * @property {number} [revenue]
 */

/**
 * @typedef {Object} AeCaptureJob
 * @property {number} idsite
 * @property {number} idsitehsr
 * @property {string} url
 * @property {string} [pageType]
 * @property {string[]} [deviceClasses] render per device class
 * @property {string[]} [want] naming | render | saliency
 * @property {string} [reason] why the capture was enqueued (e.g. taxonomy_upgrade)
 */

/**
 * @typedef {Object} AeElementBindingInput
 * @property {string} selector
 * @property {string} element_class one of domain/taxonomy.js ELEMENT_CLASSES
 * @property {string} [element_role]
 * @property {string} [name]
 * @property {string} [template_family]
 * @property {number} [position_index] -1 = unknown
 * @property {string} [section_id]
 * @property {string} [naming_provenance] human | ai | ai_vouched | legacy_v1
 * @property {number} [ai_confidence]
 * @property {string} [human_confirmed_by]
 * @property {string} [rollup_grain] selector | instance | kind | decline
 * @property {boolean} [attention_enrolled]
 * @property {string} [named_on] YYYY-MM-DD, default capturedOn
 */

/**
 * One render device payload for completeCapture (ae_page_render +
 * ae_render_node), mapped from the bot's render.<device>.json by the capture
 * consumer. sections[] and elements[] keep the artifact's own fields; the
 * adapter derives node rows and geometry from them.
 *
 * @typedef {Object} AeRenderInput
 * @property {string} device_class desktop | mobile | tablet
 * @property {number} viewport_w
 * @property {number} viewport_h
 * @property {number} page_height_px
 * @property {number} fold_px
 * @property {string} [screenshot_uri] Q9 default: local-disk path relative to datasetRoot ('' when absent)
 * @property {string} content_hash
 * @property {string} dom_hash
 * @property {string} rendered_at ISO timestamp
 * @property {string} renderer_version
 * @property {Array<object>} [sections] {id, selector?, top, height, type?, words?}
 * @property {Array<object>} [elements] {selector, section_id?, dom_order?, x, y, w, h, ...}
 */

/**
 * @typedef {Object} AeCaptureComplete
 * @property {number} idsite
 * @property {number} idsitehsr
 * @property {string} [url]
 * @property {string} capturedOn YYYY-MM-DD
 * @property {object} [coverage] classes found, selectors bound, attention-enrolled count
 * @property {boolean} [hasRender] kept for callers that predate `renders`; a
 *   non-empty renders list forces has_render 1
 * @property {boolean} [hasSaliency]
 * @property {AeElementBindingInput[]} [bindings]
 * @property {AeRenderInput[]} [renders] one per device class; writes
 *   ae_page_render + ae_render_node and logs render drift (§9.3)
 */

/**
 * One node's saliency prediction (ae_render_node.saliency_*; D-08). share is
 * the node's fraction of total predicted saliency on its device screenshot,
 * quartile the within-page/within-viewport quartile — both model-computed.
 *
 * @typedef {Object} AeSaliencyNode
 * @property {string} node_id ae_render_node.node_id
 * @property {number} saliency_share 0..1
 * @property {number} saliency_quartile 1..4
 */

/**
 * @typedef {Object} AeSaliencyWrite
 * @property {number} idsite
 * @property {number} idsitehsr
 * @property {string} device_class
 * @property {AeSaliencyNode[]} nodes
 * @property {string} model model id written to saliency_model
 */

/**
 * One descriptor row; rows with a template_key are page descriptor rows,
 * rows without are store descriptor rows (ae_page_descriptor /
 * ae_store_descriptor).
 *
 * @typedef {Object} AeDescriptorRow
 * @property {number} idsite
 * @property {string} [template_key] page descriptor only
 * @property {string} [device_class] 'all' | 'mobile' | 'desktop' | 'tablet', default 'all'
 * @property {string} field_path p00.walk … s36.commercial, with sub-paths
 * @property {string} value_json JSON literal; 'null' = Unknown
 * @property {string} [provenance] operator | bot_draft | dom | render | measured | api | derived
 * @property {string} [confidence] high | low
 * @property {string} [human_confirmed_by]
 * @property {string} [owner]
 * @property {string} [captured_at]
 * @property {string} [expires_at]
 * @property {string} [invalidated_by]
 * @property {number} [descriptor_version]
 */

/**
 * @typedef {Object} AeChangeRow
 * @property {number} idsite
 * @property {string} change_id deterministic hash of (kind, subject, effective_at)
 * @property {string} change_kind
 * @property {string} effective_at
 * @property {string} [detected_at]
 * @property {string} [source]
 * @property {string} [subject]
 * @property {object} [detail]
 */

/**
 * One ae_experiment row (governance import, O04). arms stays an array of
 * {arm, description?, allocation?}; the adapters serialize it to the JSON
 * column. Idempotent on (idsite, experiment_id).
 *
 * @typedef {Object} AeExperimentRow
 * @property {number} idsite
 * @property {string} experimentId
 * @property {string} [source] partner_tags | tool | operator, default 'operator'
 * @property {string} [partner]
 * @property {string} [name]
 * @property {string[]} [strategyRefs]
 * @property {string} [unit] session | visitor | order | request | recipient
 * @property {Array<{arm: string, description?: string, allocation?: number|null}>} arms
 * @property {string} [segmentScope]
 * @property {string} [testCode] AB | SEG-AB | ROT | FIX | HOLD | INSTR | DEST
 * @property {number} [mde]
 * @property {string} [analysisPlan] fixed | sequential
 * @property {string} [startedAt]
 * @property {string} [endedAt]
 * @property {string} [status] planned | running | concluded | stopped, default 'planned'
 * @property {object} [result]
 */

/**
 * One ae_experiment_descriptor row. provenance `operator` comes from the
 * governance import; `observed` is the experiment-analysis dataset's merge
 * of what it inferred with the operator row. Dates are YYYY-MM-DD.
 *
 * @typedef {Object} AeExperimentDescriptorRow
 * @property {number} idsite
 * @property {string} experimentKey `{partner}:{partner experiment id}`
 * @property {string} provenance operator | observed
 * @property {string} [partner]
 * @property {string} [partnerExperimentId]
 * @property {string} [name]
 * @property {string} [hypothesis]
 * @property {string} [description]
 * @property {string} [kind] experiment | rollout | personalization | internal | single_arm
 * @property {string} [scope] site | template | page | redirect | script | unknown
 * @property {string} [scopeSource] operator | registry | name | none
 * @property {string} [deviceScope] mobile | desktop, empty for every device
 * @property {string[]} [templates] page types a visit must view to be exposed
 * @property {number[]} [pages] idsitehsr under test
 * @property {Array<{selector: string, idsitehsr?: number, arm?: string, element_class?: string, section?: string}>} [elements]
 * @property {Array<{section: string, idsitehsr?: number, role: 'treated' | 'guardrail'}>} [zones] rollup sections by section_level_data name
 * @property {Array<{arm: string, label?: string, is_control?: boolean, allocation?: number | null, aliases?: string[], visits?: number, stray?: boolean}>} [arms]
 * @property {string | null} [declaredStart]
 * @property {string | null} [declaredEnd]
 * @property {string | null} [observedStart]
 * @property {string | null} [observedEnd]
 * @property {string | null} [lastSeen]
 * @property {number} [peakDailyVisits]
 * @property {number} [assignedVisits]
 * @property {string} [status] running | recent | ended | trace
 * @property {string | null} [statusAsOf]
 * @property {object} [metrics]
 */

/**
 * One ae_experiment_row row. basis is assigned | exposed | multi_arm for
 * experiment and page rows, section_captured | section_seen |
 * section_clicked for rollup rows, clicked for element rows. idsitehsr 0
 * with section and selector '' is the experiment total.
 *
 * @typedef {Object} AeExperimentAnalysisRow
 * @property {string} batchId
 * @property {number} idsite
 * @property {string} experimentKey
 * @property {string} arm canonical arm id, '' on multi_arm rows
 * @property {boolean} isControl
 * @property {string} scope
 * @property {string} basis
 * @property {number} idsitehsr
 * @property {string} [section] rollup section name, '' outside rollup and element rows
 * @property {string} selector
 * @property {string} elementClass
 * @property {string} viewportType all | desktop | tablet | mobile | unknown
 * @property {string} segment
 * @property {string} segmentValue
 * @property {string} day YYYY-MM-DD, the visit's first assignment day
 * @property {number} dayIndex days since the analysis start
 * @property {number} sessions
 * @property {number} buyers
 * @property {number} orders
 * @property {number} revenue
 * @property {number} clicks
 * @property {number} progressed
 * @property {object} metrics row_kind and revenue_sq
 */

/**
 * One ae_review_verdict row (governance import, O05). Idempotent on the
 * table ORDER BY key (idsite, subject_kind, subject_ref, verdict_kind,
 * verdict_id).
 *
 * @typedef {Object} AeReviewVerdictRow
 * @property {number} idsite
 * @property {string} verdictId uuid when the import omits it
 * @property {string} subjectKind strategy | requirement | element | event | policy | claim | surface
 * @property {string} subjectRef
 * @property {string} verdictKind recording_review | deterministic_repro | legal_signoff | copy_approval | event_validation | taxonomy_validation | journey_walk
 * @property {string} outcome pass | fail | inconclusive
 * @property {string} [population]
 * @property {number} [sampleSize]
 * @property {number} [agreementRate] 0..1
 * @property {string} [evidenceUri]
 * @property {string} reviewedBy
 * @property {string} [reviewedAt] default clock
 * @property {string} [expiresAt]
 */

/**
 * One ae_tool_registry row (V13, plan §7.3): one row per (idsite, tool).
 * Seeded from Phase 0 observations (src/catalog/tool-registry.seed.json,
 * positive observations only — absence of a row is not evidence) and
 * extended by operator import; the ReplacingMergeTree makes a re-write of
 * the same (idsite, tool) row a replace.
 *
 * @typedef {Object} AeToolRegistryRow
 * @property {number} idsite
 * @property {string} tool lowercase slug [a-z0-9_]
 * @property {string} [vendor]
 * @property {string} [parent_company]
 * @property {number} [installed] 0 | 1
 * @property {string[]} [modules]
 * @property {string} [plan_tier]
 * @property {string} [pricing_basis]
 * @property {string[]} [surfaces_owned] observed surface ids
 * @property {string} [identity_key]
 * @property {string} [revenue_join_class] unknown | tool_event | order_only
 * @property {string} [event_taxonomy_status] documented | observed | undocumented
 * @property {string} [api_status] unknown | available | unavailable | partial
 * @property {string[]} [detection_sources]
 * @property {string} [detection_confidence] low | medium | high
 * @property {string} [verified_by_walk_at] journey-walk verification timestamp
 * @property {string} [provenance] operator | script_hint | builtwith | vendor_api | journey_walk
 * @property {string} [captured_at]
 * @property {string} [expires_at]
 * @property {string} [note] free-text operator caveat
 */

/**
 * A flattened row for ae_dataset_row.
 *
 * @typedef {Object} AeDatasetRow
 * @property {string} batchId
 * @property {number} idsite
 * @property {number} idsitehsr 0 for site-scope rows
 * @property {string} [scope] 'page' | 'site', default 'page'
 * @property {string} datasetId
 * @property {string} [botFilter] 'none' | 'exclude_confirmed'; empty when not session-based
 * @property {string} [dimWeek] YYYY-MM-DD
 * @property {string} [dimDevice]
 * @property {string} [dimSource]
 * @property {string} [dimReturning]
 * @property {string} [dimSelector]
 * @property {string} [dimElementClass]
 * @property {string} [dimSurface]
 * @property {string} [dimTool]
 * @property {object} [dimExtra]
 * @property {object} metrics
 * @property {string} rowKey
 * @property {string} [subjectType] default 'page'
 * @property {string} [subjectKey] default the idsitehsr as a string, '' at site scope
 */

/**
 * A finished dataset for one batch, site, and page. Written after the
 * dataset rows so a restarted run can skip the collection.
 *
 * @typedef {Object} AeAnalysisCheckpoint
 * @property {string} batchId
 * @property {number} idsite
 * @property {number} idsitehsr 0 for site scope
 * @property {string} datasetId
 * @property {string} [scope] 'page' | 'site'
 * @property {number} [rowCount]
 * @property {string} [notes] JSON object
 * @property {string} [subjectType] default 'page'
 * @property {string} [subjectKey] default the idsitehsr as a string, '' at site scope
 */

/**
 * One week of one subject under one segmentation strategy.
 * Stored in ae_trend_row. The metric columns are the same for every
 * row type so a facet can compare them. metrics holds extras.
 *
 * @typedef {Object} AeTrendRow
 * @property {string} batchId
 * @property {number} idsite
 * @property {number} idsitehsr 0 when the subject is not a page
 * @property {string} rowType journey | page | element | experiment
 * @property {string} rowKey subject family: step, path, template, page, element_class
 * @property {string} rowKey1 step name, path, template, page id, or element class
 * @property {string} [rowKey2] selector, url, or empty
 * @property {string} viewportType all | desktop | tablet | mobile | unknown
 * @property {string} segment strategy name; 'all' is the unsegmented total
 * @property {string} segmentValue one value of that strategy
 * @property {string} week Monday, YYYY-MM-DD
 * @property {number} sessions
 * @property {number} buyers
 * @property {number} orders
 * @property {number} revenue
 * @property {number} clicks
 * @property {number} progressed
 * @property {object} [metrics]
 */

/**
 * One week of one session-tag value under one strategy. Stored in
 * ae_session_tag_trend. The values of one tag key partition the sessions.
 *
 * @typedef {Object} AeSessionTagTrendRow
 * @property {string} batchId
 * @property {number} idsite
 * @property {string} tagKey
 * @property {string} tagValue a selected value, `(none)`, or `other`
 * @property {string} viewportType all | desktop | tablet | mobile | unknown
 * @property {string} segment strategy name; 'all' is the unsegmented total
 * @property {string} segmentValue one value of that strategy
 * @property {string} week Monday, YYYY-MM-DD
 * @property {number} sessions
 * @property {number} buyers
 * @property {number} orders
 * @property {number} revenue
 * @property {number} progressed sessions that reached checkout_started
 * @property {object} [metrics]
 */

/**
 * One tag key's verdict from the session-tag selector.
 * @typedef {Object} AeSessionTagSelectionRow
 * @property {string} batchId
 * @property {number} idsite
 * @property {string} tagKey
 * @property {string} adapterId
 * @property {string} family
 * @property {'selected' | 'rejected'} status
 * @property {string} reason
 * @property {string} windowStart
 * @property {string} windowEnd
 * @property {number} taggedSessions
 * @property {number} distinctValues
 * @property {number | null} rpsZ
 * @property {number | null} rpsSpread
 * @property {number | null} aovZ
 * @property {number | null} aovSpread
 * @property {string[]} trendValues
 * @property {object} [metrics]
 */

/**
 * One page's selector list for the trend job.
 * @typedef {Object} AeTrendSelectorRow
 * @property {number} idsite
 * @property {number} idsitehsr
 * @property {string[]} trendSelectors
 * @property {string} status active | paused
 */

/**
 * @typedef {Object} AeRequirementStatusRow
 * @property {string} batchId
 * @property {number} idsite
 * @property {number} idsitehsr 0 for site-scope requirements
 * @property {string} requirementKey
 * @property {string} status available | partial | missing | unknown_value | expired | not_applicable
 * @property {string} [datasetId]
 * @property {string} [source]
 * @property {number} [rowCount]
 * @property {string} [detail] what is missing
 * @property {string} [subjectType] default 'page'
 * @property {string} [subjectKey] default the idsitehsr as a string, '' at site scope
 */

/**
 * One strategy card for ae_strategy_card. Arrays stay arrays; confounds and
 * card are JSON-serialized on write.
 *
 * @typedef {Object} AeStrategyCardRow
 * @property {string} batchId
 * @property {number} idsite
 * @property {number} idsitehsr 0 for site-scope cards
 * @property {string} catalogId
 * @property {string} strategyId
 * @property {string} [segmentKey] 'all' or e.g. 'mobile|new|paid_social'; a non-page subject's cards carry its subject key here
 * @property {string} [subjectType] default 'page'
 * @property {string} [subjectKey] default the idsitehsr as a string, '' at site scope
 * @property {string} [scope]
 * @property {string} [surface]
 * @property {string} [tool]
 * @property {string} verdict include | conditional | exclude
 * @property {string} [triggerState] triggered | silent | below_floor | blocked
 * @property {string} [structuralState] present | addable | blocked | unknown
 * @property {string} [gateFailed]
 * @property {string} [blockingRule]
 * @property {string[]} [missingRequirements]
 * @property {boolean} [triggerEvaluated]
 * @property {string[]} [triggeredRules]
 * @property {string} [observationalTrigger]
 * @property {string} [floorStandard]
 * @property {string} [metric]
 * @property {number} [value]
 * @property {number} [threshold]
 * @property {string} [confidence]
 * @property {object} [confounds] {confound: cleared | open | not_applicable}
 * @property {string} [attributionLabel]
 * @property {string} [testCode] AB | SEG-AB | ROT | FIX | HOLD | INSTR | DEST
 * @property {string} [killMetric]
 * @property {string[]} [guardrails]
 * @property {number} [impactProxy]
 * @property {number} [score]
 * @property {string} [scoreBasis]
 * @property {string} [effortClass]
 * @property {string} [owner]
 * @property {string} [exclusionReeval]
 * @property {object} [card] full card in the catalog's own format
 * @property {string} [cardJson] pre-serialized card, wins over card
 */

/**
 * One ae_page_analysis row; camelCase mirrors the DDL columns.
 *
 * @typedef {Object} AePageAnalysisRow
 * @property {string} batchId
 * @property {number} idsite
 * @property {number} idsitehsr
 * @property {string} [url]
 * @property {string} [pageTitle]
 * @property {string} [pageType]
 * @property {string} [templateFamily]
 * @property {string} [role]
 * @property {string} windowStart
 * @property {string} windowEnd
 * @property {number} [entrySessions]
 * @property {number} [orders]
 * @property {number} [revenue]
 * @property {number} [rps]
 * @property {number} [cvr]
 * @property {number} [aov]
 * @property {number} [singlePageviewShare]
 * @property {number} [scrollReach25]
 * @property {number} [scrollReach70]
 * @property {number} [desktopRps]
 * @property {number} [mobileRps]
 * @property {number} [mobileToDesktopRps]
 * @property {number} [botSessionsExcluded]
 * @property {number} [sessionsUnfiltered]
 * @property {number} [ordersUnfiltered]
 * @property {string} [descriptorStatus] current | expired | missing
 * @property {string} [captureStatus] current | stale | missing
 * @property {number} [requirementsAvailable]
 * @property {number} [requirementsMissing]
 * @property {number} [cardsInclude]
 * @property {number} [cardsConditional]
 * @property {number} [cardsExclude]
 * @property {number} [cardsTriggered]
 * @property {number} [cardsSilent]
 * @property {number} [cardsBelowFloor]
 * @property {number} [cardsBlocked]
 * @property {string} [status] analyzed | partial | failed
 * @property {object} [metadata]
 */

/**
 * One ae_site_analysis row; camelCase mirrors the DDL columns.
 *
 * @typedef {Object} AeSiteAnalysisRow
 * @property {string} batchId
 * @property {number} idsite
 * @property {string} windowStart
 * @property {string} windowEnd
 * @property {number} [sessions]
 * @property {number} [orders]
 * @property {number} [revenue]
 * @property {number} [rps]
 * @property {number} [cvr]
 * @property {number} [aov]
 * @property {number} [ppEligibleShare]
 * @property {number} [ppRenderedShare]
 * @property {number} [reconciliationMin]
 * @property {string} [descriptorStatus]
 * @property {string[]} [sourcesConnected]
 * @property {string[]} [sourcesMissing]
 * @property {string[]} [toolsInstalled]
 * @property {number} [requirementsAvailable]
 * @property {number} [requirementsMissing]
 * @property {number} [cardsInclude]
 * @property {number} [cardsConditional]
 * @property {number} [cardsExclude]
 * @property {number} [cardsTriggered]
 * @property {number} [cardsSilent]
 * @property {number} [cardsBelowFloor]
 * @property {number} [cardsBlocked]
 * @property {string} [status] analyzed | partial | failed
 * @property {object} [metadata]
 */

/**
 * Schema-2 persistence port (data-capture-plan.md §9.1). Both adapters
 * (ClickHouse and in-memory) implement the same contract; reads return
 * current rows (latest version per ORDER BY key) and writes are reruns of a
 * batch replace instead of duplicating. Claim methods use the v1 token
 * protocol: insert a claim row, re-read through the _current view, confirm
 * the token won; claims older than claimTtlMs are reclaimed.
 *
 * The port is the intersection of the role ports in ./persistence/; a
 * consumer names only the roles it uses.
 *
 * @typedef {{id: string}
 *   & import('./persistence/batch-store.js').BatchStore
 *   & import('./persistence/capture-store.js').CaptureStore
 *   & import('./persistence/dataset-store.js').DatasetStore
 *   & import('./persistence/trend-store.js').TrendStore
 *   & import('./persistence/session-tag-store.js').SessionTagStore
 *   & import('./persistence/descriptor-store.js').DescriptorStore
 *   & import('./persistence/governance-store.js').GovernanceStore
 *   & import('./persistence/trigger-store.js').TriggerStore
 *   & import('./persistence/card-analysis-store.js').CardAnalysisStore
 *   & import('./persistence/catalog-seed-store.js').CatalogSeedStore} AePersistencePort
 */
