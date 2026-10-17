import { randomUUID } from 'node:crypto';
import { TAXONOMY_VERSION } from '../../../domain/taxonomy.js';
import { fromSubjectTargetRow, subjectTargetRow } from '../../_lib/subject-columns.js';
import { CLAIM_TTL_MS, aeNow, IN_FLIGHT_SITE } from './support.js';

/**
 * The BatchStore role over memory: the schema-2 batch, its site queue, the page targets, and the subject targets.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/batch-store.js').BatchStore}
 */
export function createBatchStore({ store }) {
  return {
    /** @param {import('../../../ports/persistence.js').AeBatchSpec} batch */
    async createBatch(batch) {
      if (!batch.windowStart || !batch.windowEnd) {
        throw new Error('createBatch requires windowStart and windowEnd');
      }
      store.batches.set(batch.batchId, {
        batch_id: batch.batchId,
        created_at: aeNow(),
        window_start: batch.windowStart,
        window_end: batch.windowEnd,
        window_days: batch.windowDays ?? 30,
        site_source: batch.siteSource ?? '',
        qualifier: batch.qualifier ?? '',
        page_selector: batch.pageSelector ?? '',
        max_pages_per_site: batch.maxPagesPerSite ?? 6,
        catalogs: [...(batch.catalogs ?? [])],
        catalog_version: batch.catalogVersion ?? '',
        requirement_registry_version: batch.requirementRegistryVersion ?? '',
        taxonomy_version: batch.taxonomyVersion ?? TAXONOMY_VERSION,
        standards: JSON.stringify(batch.standards ?? {}),
        status: batch.status ?? 'open',
        sites_queued: batch.sitesQueued ?? 0,
        sites_analyzed: batch.sitesAnalyzed ?? 0,
        sites_skipped: batch.sitesSkipped ?? 0,
        sites_failed: batch.sitesFailed ?? 0,
        pages_analyzed: batch.pagesAnalyzed ?? 0,
        metadata: JSON.stringify(batch.metadata ?? {}),
        generated_at: aeNow(),
        profile: batch.profile ?? '',
        subject_type: batch.subjectType ?? '',
      });
    },

    /** @param {string} batchId */
    async getBatch(batchId) {
      const b = store.batches.get(batchId);
      if (!b) return null;
      return {
        batchId: b.batch_id,
        createdAt: b.created_at,
        windowStart: String(b.window_start).slice(0, 10),
        windowEnd: String(b.window_end).slice(0, 10),
        windowDays: Number(b.window_days),
        siteSource: b.site_source,
        qualifier: b.qualifier,
        pageSelector: b.page_selector,
        profile: b.profile,
        subjectType: b.subject_type,
        maxPagesPerSite: Number(b.max_pages_per_site),
        catalogs: [...(b.catalogs ?? [])],
        catalogVersion: b.catalog_version,
        requirementRegistryVersion: b.requirement_registry_version,
        taxonomyVersion: b.taxonomy_version,
        standards: JSON.parse(b.standards || '{}'),
        status: b.status,
        sitesQueued: Number(b.sites_queued),
        sitesAnalyzed: Number(b.sites_analyzed),
        sitesSkipped: Number(b.sites_skipped),
        sitesFailed: Number(b.sites_failed),
        pagesAnalyzed: Number(b.pages_analyzed),
        metadata: JSON.parse(b.metadata || '{}'),
        generatedAt: b.generated_at,
      };
    },

    /** @param {string} batchId @param {Array<{idsite: number, siteName: string}>} sites */
    async enqueueSites(batchId, sites) {
      for (const site of sites) {
        const key = `${batchId}:${site.idsite}`;
        if (!store.siteQueue.has(key)) {
          store.siteQueue.set(key, {
            batch_id: batchId,
            idsite: site.idsite,
            site_name: site.siteName ?? '',
            status: 'queued',
            reason: '',
            claim_token: '',
            pages_selected: 0,
            pages_analyzed: 0,
            entry_sessions: 0,
            orders: 0,
            revenue: 0,
            generated_at: aeNow(),
          });
        }
      }
    },

    /**
     * 'queued' rows are always claimable; in-flight rows ('claimed',
     * 'selecting_pages', 'analyzing') once the claim is older than
     * claimTtlMs. Waiting states are re-queued by their own completions.
     * @param {string} batchId
     * @param {number} [claimTtlMs]
     * @returns {Promise<{idsite: number, siteName: string} | null>}
     */
    async claimNextSite(batchId, claimTtlMs = CLAIM_TTL_MS) {
      const staleBefore = Date.now() - claimTtlMs;
      const candidates = [...store.siteQueue.values()]
        .filter((r) => r.batch_id === batchId)
        .filter(
          (r) =>
            r.status === 'queued' ||
            (IN_FLIGHT_SITE.has(r.status) && (r.claimedAt ?? 0) <= staleBefore),
        )
        .sort((a, b) => Number(a.idsite) - Number(b.idsite));
      const row = candidates[0];
      if (!row) return null;
      const token = randomUUID();
      row.status = 'claimed';
      row.claim_token = token;
      row.claimedAt = Date.now();
      row.generated_at = aeNow();
      return { idsite: row.idsite, siteName: row.site_name };
    },

    /**
     * @param {import('../../../ports/persistence.js').AeSiteUpdate} update
     */
    async updateSite(update) {
      const row = store.siteQueue.get(`${update.batchId}:${update.idsite}`);
      if (!row) throw new Error(`memory ae persistence: site row ${update.batchId}:${update.idsite} not found`);
      if (update.siteName !== undefined) row.site_name = update.siteName;
      if (update.status !== undefined) row.status = update.status;
      if (update.reason !== undefined) row.reason = update.reason;
      if (update.pagesSelected !== undefined) row.pages_selected = update.pagesSelected;
      if (update.pagesAnalyzed !== undefined) row.pages_analyzed = update.pagesAnalyzed;
      if (update.entrySessions !== undefined) row.entry_sessions = update.entrySessions;
      if (update.orders !== undefined) row.orders = update.orders;
      if (update.revenue !== undefined) row.revenue = update.revenue;
      // Heartbeat, mirroring the ClickHouse claim filter on generated_at.
      row.claimedAt = Date.now();
      row.generated_at = aeNow();
    },

    /**
     * @param {string} batchId
     * @param {number} idsite
     * @param {import('../../../ports/persistence.js').AePageTarget[]} targets
     */
    async writePageTargets(batchId, idsite, targets) {
      for (const t of targets) {
        store.pageTargets.set(`${batchId}:${idsite}:${t.idsitehsr}`, {
          batch_id: batchId,
          idsite,
          idsitehsr: t.idsitehsr,
          url: t.url ?? '',
          page_title: t.pageTitle ?? '',
          page_type: t.pageType ?? '',
          template_family: t.templateFamily ?? '',
          role: t.role ?? '',
          selection_reason: t.selectionReason ?? '',
          entry_sessions: t.entrySessions ?? 0,
          pageview_hits: t.pageviewHits ?? 0,
          orders: t.orders ?? 0,
          revenue: t.revenue ?? 0,
          status: t.status ?? 'selected',
          reason: t.reason ?? '',
          generated_at: aeNow(),
        });
      }
    },

    /**
     * @param {import('../../../ports/persistence.js').AePageTargetUpdate} update
     */
    async updatePageTarget(update) {
      const row = store.pageTargets.get(`${update.batchId}:${update.idsite}:${update.idsitehsr}`);
      if (!row) {
        throw new Error(
          `memory ae persistence: page target ${update.batchId}:${update.idsite}:${update.idsitehsr} not found`,
        );
      }
      const fields = {
        url: update.url,
        page_title: update.pageTitle,
        page_type: update.pageType,
        template_family: update.templateFamily,
        role: update.role,
        selection_reason: update.selectionReason,
        entry_sessions: update.entrySessions,
        pageview_hits: update.pageviewHits,
        orders: update.orders,
        revenue: update.revenue,
        status: update.status,
        reason: update.reason,
      };
      for (const [column, value] of Object.entries(fields)) {
        if (value !== undefined) row[column] = value;
      }
      row.generated_at = aeNow();
    },

    /**
     * @param {string} batchId
     * @param {number} idsite
     * @param {import('../../../ports/subject.js').SubjectTarget[]} targets
     */
    async writeSubjectTargets(batchId, idsite, targets) {
      for (const t of targets) {
        store.subjectTargets.set(
          `${batchId}:${idsite}:${t.subjectType}:${t.subjectKey}`,
          subjectTargetRow(batchId, idsite, t, aeNow()),
        );
      }
    },

    /** @param {{batchId: string, idsite: number}} key */
    async readSubjectTargets(key) {
      return [...store.subjectTargets.values()]
        .filter((row) => row.batch_id === key.batchId && row.idsite === key.idsite)
        .map(fromSubjectTargetRow)
        .sort((a, b) => a.subjectType.localeCompare(b.subjectType) || a.subjectKey.localeCompare(b.subjectKey));
    },

    /**
     * @param {{batchId: string, idsite: number, subjectType: string, subjectKey: string, status?: string, reason?: string}} update
     */
    async updateSubjectTarget(update) {
      const key = `${update.batchId}:${update.idsite}:${update.subjectType}:${update.subjectKey}`;
      const row = store.subjectTargets.get(key);
      if (!row) throw new Error(`subject target ${update.subjectType}:${update.subjectKey} not found`);
      const prev = fromSubjectTargetRow(row);
      store.subjectTargets.set(key, subjectTargetRow(update.batchId, update.idsite, {
        ...prev,
        status: update.status ?? prev.status,
        reason: update.reason ?? prev.reason,
      }, aeNow()));
    },
  };
}
