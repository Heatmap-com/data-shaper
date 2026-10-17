import { aeNow } from './support.js';

/**
 * The GovernanceStore role over memory: experiments, their descriptors and analysis rows, review verdicts, and the tool registry.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/governance-store.js').GovernanceStore}
 */
export function createGovernanceStore({ store }) {
  return {
    /**
     * @param {import('../../../ports/persistence.js').AeExperimentRow[]} rows
     */
    async writeExperiments(rows) {
      for (const r of rows) {
        store.experiments.set(`${r.idsite}:${r.experimentId}`, {
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
          generated_at: aeNow(),
        });
      }
    },

    /**
     * Replaces on (idsite, experimentKey, provenance).
     * @param {import('../../../ports/persistence.js').AeExperimentDescriptorRow[]} rows
     */
    async writeExperimentDescriptors(rows) {
      for (const row of rows) {
        store.experimentDescriptors.set(`${row.idsite}:${row.experimentKey}:${row.provenance}`, structuredClone(row));
      }
    },

    /** @param {number} idsite */
    async readExperimentDescriptors(idsite) {
      return [...store.experimentDescriptors.values()]
        .filter((row) => Number(row.idsite) === Number(idsite))
        .map((row) => structuredClone(row));
    },

    /**
     * Replaces on the row identity; batchId is not part of it.
     * @param {import('../../../ports/persistence.js').AeExperimentAnalysisRow[]} rows
     */
    async writeExperimentRows(rows) {
      for (const row of rows) {
        const key = [
          row.idsite, row.experimentKey, row.arm, row.basis, row.idsitehsr, row.section ?? '', row.selector,
          row.viewportType, row.segment, row.segmentValue, row.day,
        ].join(':');
        store.experimentRows.set(key, structuredClone(row));
      }
    },

    /**
     * @param {import('../../../ports/persistence.js').AeReviewVerdictRow[]} rows
     */
    async writeVerdicts(rows) {
      for (const r of rows) {
        store.verdicts.set(
          `${r.idsite}:${r.subjectKind}:${r.subjectRef}:${r.verdictKind}:${r.verdictId}`,
          {
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
            reviewed_at: r.reviewedAt ?? aeNow(),
            expires_at: r.expiresAt ?? null,
            generated_at: aeNow(),
          },
        );
      }
    },

    /**
     * Latest write per (idsite, tool) wins, mirroring the ReplacingMergeTree
     * replace of the ae_tool_registry ORDER BY key.
     * @param {import('../../../ports/persistence.js').AeToolRegistryRow[]} rows
     */
    async writeToolRegistry(rows) {
      for (const r of rows) {
        store.toolRegistry.set(`${r.idsite}:${r.tool}`, {
          idsite: r.idsite,
          tool: r.tool,
          vendor: r.vendor ?? '',
          parent_company: r.parent_company ?? '',
          installed: r.installed ? 1 : 0,
          modules: [...(r.modules ?? [])],
          plan_tier: r.plan_tier ?? '',
          pricing_basis: r.pricing_basis ?? '',
          surfaces_owned: [...(r.surfaces_owned ?? [])],
          identity_key: r.identity_key ?? '',
          revenue_join_class: r.revenue_join_class ?? 'unknown',
          event_taxonomy_status: r.event_taxonomy_status ?? 'undocumented',
          api_status: r.api_status ?? 'unknown',
          detection_sources: [...(r.detection_sources ?? [])],
          detection_confidence: r.detection_confidence ?? '',
          verified_by_walk_at: r.verified_by_walk_at ?? null,
          provenance: r.provenance ?? 'operator',
          captured_at: r.captured_at ?? aeNow(),
          expires_at: r.expires_at ?? '',
          note: r.note ?? '',
          generated_at: aeNow(),
        });
      }
    },
  };
}
