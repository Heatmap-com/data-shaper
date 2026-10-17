import { subjectColumns } from '../../_lib/subject-columns.js';
import { aeNow } from './support.js';

/**
 * The CardAnalysisStore role over memory: requirement status, strategy cards, and the page and site analysis rows.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/card-analysis-store.js').CardAnalysisStore}
 */
export function createCardAnalysisStore({ store }) {
  return {
    /** @param {{batchId: string, idsite: number}} key */
    async readRequirementStatus(key) {
      const out = [];
      for (const row of store.requirementStatus.values()) {
        if (row.batch_id !== key.batchId || row.idsite !== key.idsite) continue;
        out.push({ idsitehsr: Number(row.idsitehsr), status: row.status });
      }
      return out;
    },

    /** @param {{batchId: string, idsite: number}} key */
    async readCards(key) {
      const out = [];
      for (const row of store.strategyCards.values()) {
        if (row.batch_id !== key.batchId || row.idsite !== key.idsite) continue;
        out.push({
          idsitehsr: Number(row.idsitehsr),
          verdict: row.verdict,
          triggerState: row.trigger_state ?? '',
        });
      }
      return out;
    },

    /** @param {import('../../../ports/persistence.js').AeRequirementStatusRow[]} rows */
    async writeRequirementStatus(rows) {
      for (const r of rows) {
        store.requirementStatus.set(
          `${r.batchId}:${r.idsite}:${r.idsitehsr}:${r.requirementKey}`,
          {
            batch_id: r.batchId,
            idsite: r.idsite,
            idsitehsr: r.idsitehsr,
            requirement_key: r.requirementKey,
            status: r.status,
            dataset_id: r.datasetId ?? '',
            source: r.source ?? '',
            row_count: r.rowCount ?? 0,
            detail: r.detail ?? '',
            generated_at: aeNow(),
            ...subjectColumns(r),
          },
        );
      }
    },

    /**
     * @param {import('../../../ports/persistence.js').AeStrategyCardRow[]} rows
     */
    async writeCards(rows) {
      for (const r of rows) {
        store.strategyCards.set(
          `${r.batchId}:${r.idsite}:${r.idsitehsr}:${r.catalogId}:${r.strategyId}:${r.segmentKey ?? 'all'}`,
          {
            batch_id: r.batchId,
            idsite: r.idsite,
            idsitehsr: r.idsitehsr,
            catalog_id: r.catalogId,
            strategy_id: r.strategyId,
            segment_key: r.segmentKey ?? 'all',
            scope: r.scope ?? '',
            surface: r.surface ?? '',
            tool: r.tool ?? '',
            verdict: r.verdict,
            trigger_state: r.triggerState ?? '',
            structural_state: r.structuralState ?? '',
            gate_failed: r.gateFailed ?? '',
            blocking_rule: r.blockingRule ?? '',
            missing_requirements: [...(r.missingRequirements ?? [])],
            trigger_evaluated: r.triggerEvaluated ? 1 : 0,
            triggered_rules: [...(r.triggeredRules ?? [])],
            observational_trigger: r.observationalTrigger ?? '',
            floor_standard: r.floorStandard ?? '',
            metric: r.metric ?? '',
            value: r.value ?? null,
            threshold: r.threshold ?? null,
            confidence: r.confidence ?? '',
            confounds: JSON.stringify(r.confounds ?? {}),
            attribution_label: r.attributionLabel ?? '',
            test_code: r.testCode ?? '',
            kill_metric: r.killMetric ?? '',
            guardrails: [...(r.guardrails ?? [])],
            impact_proxy: r.impactProxy ?? null,
            score: r.score ?? null,
            score_basis: r.scoreBasis ?? '',
            effort_class: r.effortClass ?? '',
            owner: r.owner ?? '',
            exclusion_reeval: r.exclusionReeval ?? '',
            card_json:
              typeof r.cardJson === 'string' ? r.cardJson : JSON.stringify(r.card ?? {}),
            generated_at: aeNow(),
            ...subjectColumns(r),
          },
        );
      }
    },

    /** @param {import('../../../ports/persistence.js').AePageAnalysisRow} row */
    async writePageAnalysis(row) {
      store.pageAnalyses.set(`${row.batchId}:${row.idsite}:${row.idsitehsr}`, {
        batch_id: row.batchId,
        idsite: row.idsite,
        idsitehsr: row.idsitehsr,
        url: row.url ?? '',
        page_title: row.pageTitle ?? '',
        page_type: row.pageType ?? '',
        template_family: row.templateFamily ?? '',
        role: row.role ?? '',
        window_start: row.windowStart,
        window_end: row.windowEnd,
        entry_sessions: row.entrySessions ?? 0,
        orders: row.orders ?? 0,
        revenue: row.revenue ?? 0,
        rps: row.rps ?? 0,
        cvr: row.cvr ?? 0,
        aov: row.aov ?? 0,
        single_pageview_share: row.singlePageviewShare ?? 0,
        scroll_reach_25: row.scrollReach25 ?? 0,
        scroll_reach_70: row.scrollReach70 ?? 0,
        desktop_rps: row.desktopRps ?? 0,
        mobile_rps: row.mobileRps ?? 0,
        mobile_to_desktop_rps: row.mobileToDesktopRps ?? 0,
        bot_sessions_excluded: row.botSessionsExcluded ?? 0,
        sessions_unfiltered: row.sessionsUnfiltered ?? 0,
        orders_unfiltered: row.ordersUnfiltered ?? 0,
        descriptor_status: row.descriptorStatus ?? '',
        capture_status: row.captureStatus ?? '',
        requirements_available: row.requirementsAvailable ?? 0,
        requirements_missing: row.requirementsMissing ?? 0,
        cards_include: row.cardsInclude ?? 0,
        cards_conditional: row.cardsConditional ?? 0,
        cards_exclude: row.cardsExclude ?? 0,
        cards_triggered: row.cardsTriggered ?? 0,
        cards_silent: row.cardsSilent ?? 0,
        cards_below_floor: row.cardsBelowFloor ?? 0,
        cards_blocked: row.cardsBlocked ?? 0,
        status: row.status ?? 'analyzed',
        metadata: JSON.stringify(row.metadata ?? {}),
        generated_at: aeNow(),
      });
    },

    /** @param {import('../../../ports/persistence.js').AeSiteAnalysisRow} row */
    async writeSiteAnalysis(row) {
      store.siteAnalyses.set(`${row.batchId}:${row.idsite}`, {
        batch_id: row.batchId,
        idsite: row.idsite,
        window_start: row.windowStart,
        window_end: row.windowEnd,
        sessions: row.sessions ?? 0,
        orders: row.orders ?? 0,
        revenue: row.revenue ?? 0,
        rps: row.rps ?? 0,
        cvr: row.cvr ?? 0,
        aov: row.aov ?? 0,
        pp_eligible_share: row.ppEligibleShare ?? null,
        pp_rendered_share: row.ppRenderedShare ?? null,
        reconciliation_min: row.reconciliationMin ?? null,
        descriptor_status: row.descriptorStatus ?? '',
        sources_connected: [...(row.sourcesConnected ?? [])],
        sources_missing: [...(row.sourcesMissing ?? [])],
        tools_installed: [...(row.toolsInstalled ?? [])],
        requirements_available: row.requirementsAvailable ?? 0,
        requirements_missing: row.requirementsMissing ?? 0,
        cards_include: row.cardsInclude ?? 0,
        cards_conditional: row.cardsConditional ?? 0,
        cards_exclude: row.cardsExclude ?? 0,
        cards_triggered: row.cardsTriggered ?? 0,
        cards_silent: row.cardsSilent ?? 0,
        cards_below_floor: row.cardsBelowFloor ?? 0,
        cards_blocked: row.cardsBlocked ?? 0,
        status: row.status ?? 'analyzed',
        metadata: JSON.stringify(row.metadata ?? {}),
        generated_at: aeNow(),
      });
    },

    /**
     * @param {{idsite: number, strategyId: string, n: number}} key
     */
    async cardHistory(key) {
      return [...store.strategyCards.values()]
        .filter(
          (row) =>
            Number(row.idsite) === Number(key.idsite) && row.strategy_id === key.strategyId,
        )
        .sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)))
        .slice(0, key.n)
        .map((row) => ({ ...row }));
    },
  };
}
