import { clock, experimentDescriptorFromCh } from './support.js';

/**
 * The GovernanceStore role over ClickHouse: experiments, their descriptors and analysis rows, review verdicts, and the tool registry.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/governance-store.js').GovernanceStore}
 */
export function createGovernanceStore({ client, database, log, timedWrite, run }) {
  return {
    /**
     * Rerun-safe on (idsite, experiment_id): a re-imported experiment
     * replaces its ReplacingMergeTree row.
     * @param {import('../../../ports/persistence.js').AeExperimentRow[]} rows
     */
    async writeExperiments(rows) {
      if (rows.length === 0) return;
      await client.insert({
        table: `${database}.ae_experiment`,
        format: 'JSONEachRow',
        values: rows.map((r) => ({
          idsite: r.idsite,
          experiment_id: r.experimentId,
          source: r.source ?? 'operator',
          partner: r.partner ?? '',
          name: r.name ?? '',
          strategy_refs: r.strategyRefs ?? [],
          unit: r.unit ?? '',
          arms: JSON.stringify(r.arms ?? []),
          segment_scope: r.segmentScope ?? '',
          test_code: r.testCode ?? '',
          mde: r.mde ?? null,
          analysis_plan: r.analysisPlan ?? '',
          started_at: r.startedAt ?? null,
          ended_at: r.endedAt ?? null,
          status: r.status ?? 'planned',
          result: r.result ? JSON.stringify(r.result) : '',
          generated_at: clock.now(),
        })),
      });
      log('writeExperiments', { rows: rows.length });
    },

    /**
     * Replaces on (idsite, experiment_key, provenance). The dataset writes
     * `observed`; the governance import writes `operator`.
     * @param {import('../../../ports/persistence.js').AeExperimentDescriptorRow[]} rows
     */
    async writeExperimentDescriptors(rows) {
      if (rows.length === 0) return;
      await timedWrite('ae_experiment_descriptor', rows, () => client.insert({
        table: `${database}.ae_experiment_descriptor`,
        format: 'JSONEachRow',
        values: rows.map((r) => ({
          idsite: r.idsite,
          experiment_key: r.experimentKey,
          provenance: r.provenance,
          partner: r.partner ?? '',
          partner_experiment_id: r.partnerExperimentId ?? '',
          name: r.name ?? '',
          hypothesis: r.hypothesis ?? '',
          description: r.description ?? '',
          kind: r.kind ?? '',
          scope: r.scope ?? '',
          scope_source: r.scopeSource ?? '',
          device_scope: r.deviceScope ?? '',
          templates: r.templates ?? [],
          pages: r.pages ?? [],
          elements: JSON.stringify(r.elements ?? []),
          zones: JSON.stringify(r.zones ?? []),
          arms: JSON.stringify(r.arms ?? []),
          declared_start: r.declaredStart ?? null,
          declared_end: r.declaredEnd ?? null,
          observed_start: r.observedStart ?? null,
          observed_end: r.observedEnd ?? null,
          last_seen: r.lastSeen ?? null,
          peak_daily_visits: r.peakDailyVisits ?? 0,
          assigned_visits: r.assignedVisits ?? 0,
          status: r.status ?? '',
          status_as_of: r.statusAsOf ?? null,
          metrics: JSON.stringify(r.metrics ?? {}),
          generated_at: clock.now(),
        })),
      }));
      log('writeExperimentDescriptors', { rows: rows.length });
    },

    /**
     * Latest row per (experiment_key, provenance) for the site.
     * @param {number} idsite
     * @returns {Promise<import('../../../ports/persistence.js').AeExperimentDescriptorRow[]>}
     */
    async readExperimentDescriptors(idsite) {
      const rows = await run(client.query({
        query: `
          SELECT *
            FROM ${database}.ae_experiment_descriptor_current
           WHERE idsite = {idsite:UInt32}`,
        query_params: { idsite },
        format: 'JSONEachRow',
      }));
      return rows.map(experimentDescriptorFromCh);
    },

    /**
     * Replaces on the row identity: experiment, arm, basis, page, section,
     * selector, viewport, segment, segment value, and day. batch_id is not
     * in the key, so a rerun replaces the day.
     * @param {import('../../../ports/persistence.js').AeExperimentAnalysisRow[]} rows
     */
    async writeExperimentRows(rows) {
      if (rows.length === 0) return;
      await timedWrite('ae_experiment_row', rows, () => client.insert({
        table: `${database}.ae_experiment_row`,
        format: 'JSONEachRow',
        values: rows.map((r) => ({
          batch_id: r.batchId,
          idsite: r.idsite,
          experiment_key: r.experimentKey,
          arm: r.arm ?? '',
          is_control: r.isControl ? 1 : 0,
          scope: r.scope ?? '',
          basis: r.basis,
          idsitehsr: r.idsitehsr ?? 0,
          section: r.section ?? '',
          selector: r.selector ?? '',
          element_class: r.elementClass ?? '',
          viewport_type: r.viewportType,
          segment: r.segment,
          segment_value: r.segmentValue,
          day: r.day,
          day_index: r.dayIndex ?? 0,
          sessions: r.sessions ?? 0,
          buyers: r.buyers ?? 0,
          orders: r.orders ?? 0,
          revenue: r.revenue ?? 0,
          clicks: r.clicks ?? 0,
          progressed: r.progressed ?? 0,
          metrics: JSON.stringify(r.metrics ?? {}),
          generated_at: clock.now(),
        })),
      }));
      log('writeExperimentRows', { rows: rows.length });
    },

    /**
     * Rerun-safe on the verdict ORDER BY key: a re-imported verdict
     * replaces its ReplacingMergeTree row.
     * @param {import('../../../ports/persistence.js').AeReviewVerdictRow[]} rows
     */
    async writeVerdicts(rows) {
      if (rows.length === 0) return;
      await client.insert({
        table: `${database}.ae_review_verdict`,
        format: 'JSONEachRow',
        values: rows.map((r) => ({
          idsite: r.idsite,
          verdict_id: r.verdictId,
          subject_kind: r.subjectKind,
          subject_ref: r.subjectRef,
          verdict_kind: r.verdictKind,
          population: r.population ?? '',
          sample_size: r.sampleSize ?? 0,
          agreement_rate: r.agreementRate ?? null,
          outcome: r.outcome,
          evidence_uri: r.evidenceUri ?? '',
          reviewed_by: r.reviewedBy,
          reviewed_at: r.reviewedAt ?? clock.now(),
          expires_at: r.expiresAt ?? null,
          generated_at: clock.now(),
        })),
      });
      log('writeVerdicts', { rows: rows.length });
    },

    /**
     * One row per (idsite, tool); a re-write of the same key replaces by
     * ReplacingMergeTree(generated_at). Rows carry the V13 fact shape
     * (plan §7.3); verified_by_walk_at stays NULL until a journey walk
     * confirms the tool's events.
     * @param {import('../../../ports/persistence.js').AeToolRegistryRow[]} rows
     */
    async writeToolRegistry(rows) {
      if (rows.length === 0) return;
      await client.insert({
        table: `${database}.ae_tool_registry`,
        format: 'JSONEachRow',
        values: rows.map((r) => ({
          idsite: r.idsite,
          tool: r.tool,
          vendor: r.vendor ?? '',
          parent_company: r.parent_company ?? '',
          installed: r.installed ? 1 : 0,
          modules: r.modules ?? [],
          plan_tier: r.plan_tier ?? '',
          pricing_basis: r.pricing_basis ?? '',
          surfaces_owned: r.surfaces_owned ?? [],
          identity_key: r.identity_key ?? '',
          revenue_join_class: r.revenue_join_class ?? 'unknown',
          event_taxonomy_status: r.event_taxonomy_status ?? 'undocumented',
          api_status: r.api_status ?? 'unknown',
          detection_sources: r.detection_sources ?? [],
          detection_confidence: r.detection_confidence ?? '',
          verified_by_walk_at: r.verified_by_walk_at ?? null,
          provenance: r.provenance ?? 'operator',
          captured_at: r.captured_at ?? clock.now(),
          expires_at: r.expires_at ?? '',
          note: r.note ?? '',
          generated_at: clock.now(),
        })),
      });
      log('writeToolRegistry', { rows: rows.length });
    },
  };
}
