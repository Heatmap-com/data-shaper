import { randomUUID } from 'node:crypto';
import { TAXONOMY_VERSION } from '../../../domain/taxonomy.js';
import { fromSubjectTargetRow, subjectTargetRow } from '../../_lib/subject-columns.js';
import { CLAIM_TTL_MS, oneAtATime, staleBeforeCh, clock, toIsoDate } from './support.js';

/**
 * The BatchStore role over ClickHouse: the schema-2 batch, its site queue, the page targets, and the subject targets.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/batch-store.js').BatchStore}
 */
export function createBatchStore({ client, database, log, run, readCurrent }) {
  const serial = oneAtATime();

  /** One claim: the read, the token insert, and the read-back. */
  async function claimSite(batchId, claimTtlMs) {
    const candidates = await run(
      client.query({
        query: `
          SELECT *
            FROM ${database}.ae_site_queue_current
           WHERE batch_id = {batchId:UUID}
             AND (status = 'queued'
                  OR (status IN ('claimed', 'selecting_pages', 'analyzing')
                      AND generated_at <= {staleBefore:String}::DateTime64(3)))
           ORDER BY idsite
           LIMIT 1`,
        query_params: { batchId, staleBefore: staleBeforeCh(claimTtlMs) },
        format: 'JSONEachRow',
      }),
    );
    const row = candidates[0];
    if (!row) return null;
    const token = randomUUID();
    await client.insert({
      table: `${database}.ae_site_queue`,
      format: 'JSONEachRow',
      values: [
        {
          batch_id: batchId,
          idsite: Number(row.idsite),
          site_name: row.site_name ?? '',
          status: 'claimed',
          reason: row.reason ?? '',
          claim_token: token,
          pages_selected: Number(row.pages_selected ?? 0),
          pages_analyzed: Number(row.pages_analyzed ?? 0),
          entry_sessions: Number(row.entry_sessions ?? 0),
          orders: Number(row.orders ?? 0),
          revenue: Number(row.revenue ?? 0),
          generated_at: clock.now(),
        },
      ],
    });
    const mine = await readCurrent(
      'ae_site_queue',
      'batch_id = {batchId:UUID} AND idsite = {idsite:UInt32}',
      { batchId, idsite: Number(row.idsite) },
    );
    if (String(mine[0]?.claim_token ?? '') !== token) return null;
    return { idsite: Number(row.idsite), siteName: row.site_name ?? '' };
  }

  return {
    /**
     * @param {import('../../../ports/persistence.js').AeBatchSpec} batch
     */
    async createBatch(batch) {
      if (!batch.windowStart || !batch.windowEnd) {
        throw new Error('createBatch requires windowStart and windowEnd');
      }
      await client.insert({
        table: `${database}.ae_batch`,
        format: 'JSONEachRow',
        values: [
          {
            batch_id: batch.batchId,
            created_at: clock.now(),
            window_start: batch.windowStart,
            window_end: batch.windowEnd,
            window_days: batch.windowDays ?? 30,
            site_source: batch.siteSource ?? '',
            qualifier: batch.qualifier ?? '',
            page_selector: batch.pageSelector ?? '',
            max_pages_per_site: batch.maxPagesPerSite ?? 6,
            catalogs: batch.catalogs ?? [],
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
            generated_at: clock.now(),
            profile: batch.profile ?? '',
            subject_type: batch.subjectType ?? '',
          },
        ],
      });
    },

    /** @param {string} batchId */
    async getBatch(batchId) {
      const rows = await readCurrent('ae_batch', 'batch_id = {batchId:UUID}', { batchId });
      if (rows.length === 0) return null;
      const b = rows[0];
      return {
        batchId: b.batch_id,
        createdAt: b.created_at,
        windowStart: toIsoDate(b.window_start),
        windowEnd: toIsoDate(b.window_end),
        windowDays: Number(b.window_days),
        siteSource: b.site_source,
        qualifier: b.qualifier,
        pageSelector: b.page_selector,
        profile: String(b.profile ?? ''),
        subjectType: String(b.subject_type ?? ''),
        maxPagesPerSite: Number(b.max_pages_per_site),
        catalogs: b.catalogs ?? [],
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
      if (sites.length === 0) return;
      const selects = sites
        .map(
          (_, i) =>
            `SELECT {idsite${i}:UInt32} AS idsite, {name${i}:String} AS site_name, {ts${i}:DateTime64(3)} AS ts`,
        )
        .join(' UNION ALL ');
      const params = { batchId };
      sites.forEach((s, i) => {
        params[`idsite${i}`] = s.idsite;
        params[`name${i}`] = s.siteName ?? '';
        params[`ts${i}`] = clock.now();
      });
      await client.command({
        query: `
          INSERT INTO ${database}.ae_site_queue
              (batch_id, idsite, site_name, status, reason, claim_token, pages_selected, pages_analyzed, entry_sessions, orders, revenue, generated_at)
          SELECT {batchId:UUID}, n.idsite, n.site_name, 'queued', '', '', 0, 0, 0, 0, 0, n.ts
          FROM (${selects}) n
          LEFT ANTI JOIN (
              SELECT idsite FROM ${database}.ae_site_queue_current WHERE batch_id = {batchId:UUID}
          ) cur ON cur.idsite = n.idsite
        `,
        query_params: params,
      });
      log('enqueueSites', { batchId, sites: sites.length });
    },

    /**
     * Token-claimed, same protocol as v1 claimNext: 'queued' rows are always
     * claimable; 'claimed'/'selecting_pages'/'analyzing' rows only once the
     * claim is older than claimTtlMs (a crashed worker's site is reclaimed,
     * live agents never steal each other). Waiting states
     * (awaiting_capture, awaiting_descriptor) are re-queued by their own
     * completions, never by a claim. Returns one row or null. Claims made
     * through one store run one at a time, so the agents of one batch run
     * never both win a site.
     * @param {string} batchId
     * @param {number} [claimTtlMs]
     * @returns {Promise<{idsite: number, siteName: string} | null>}
     */
    claimNextSite(batchId, claimTtlMs = CLAIM_TTL_MS) {
      return serial(() => claimSite(batchId, claimTtlMs));
    },

    /**
     * Merges like v1 updateQueue: reads the current row, writes one new
     * version carrying the provided fields over the previous values.
     * @param {import('../../../ports/persistence.js').AeSiteUpdate} update
     */
    async updateSite(update) {
      const current = await readCurrent(
        'ae_site_queue',
        'batch_id = {batchId:UUID} AND idsite = {idsite:UInt32}',
        { batchId: update.batchId, idsite: update.idsite },
      );
      const prev = current[0] ?? {};
      await client.insert({
        table: `${database}.ae_site_queue`,
        format: 'JSONEachRow',
        values: [
          {
            batch_id: update.batchId,
            idsite: update.idsite,
            site_name: update.siteName ?? prev.site_name ?? '',
            status: update.status ?? prev.status ?? 'queued',
            reason: update.reason ?? prev.reason ?? '',
            claim_token: String(prev.claim_token ?? ''),
            pages_selected: update.pagesSelected ?? Number(prev.pages_selected ?? 0),
            pages_analyzed: update.pagesAnalyzed ?? Number(prev.pages_analyzed ?? 0),
            entry_sessions: update.entrySessions ?? Number(prev.entry_sessions ?? 0),
            orders: update.orders ?? Number(prev.orders ?? 0),
            revenue: update.revenue ?? Number(prev.revenue ?? 0),
            generated_at: clock.now(),
          },
        ],
      });
    },

    /**
     * @param {string} batchId
     * @param {number} idsite
     * @param {import('../../../ports/persistence.js').AePageTarget[]} targets
     */
    async writePageTargets(batchId, idsite, targets) {
      if (targets.length === 0) return;
      await client.insert({
        table: `${database}.ae_page_target`,
        format: 'JSONEachRow',
        values: targets.map((t) => ({
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
          generated_at: clock.now(),
        })),
      });
      log('writePageTargets', { batchId, idsite, targets: targets.length });
    },

    /**
     * @param {import('../../../ports/persistence.js').AePageTargetUpdate} update
     */
    async updatePageTarget(update) {
      const current = await readCurrent(
        'ae_page_target',
        'batch_id = {batchId:UUID} AND idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}',
        { batchId: update.batchId, idsite: update.idsite, idsitehsr: update.idsitehsr },
      );
      const prev = current[0] ?? {};
      await client.insert({
        table: `${database}.ae_page_target`,
        format: 'JSONEachRow',
        values: [
          {
            batch_id: update.batchId,
            idsite: update.idsite,
            idsitehsr: update.idsitehsr,
            url: update.url ?? prev.url ?? '',
            page_title: update.pageTitle ?? prev.page_title ?? '',
            page_type: update.pageType ?? prev.page_type ?? '',
            template_family: update.templateFamily ?? prev.template_family ?? '',
            role: update.role ?? prev.role ?? '',
            selection_reason: update.selectionReason ?? prev.selection_reason ?? '',
            entry_sessions: update.entrySessions ?? Number(prev.entry_sessions ?? 0),
            pageview_hits: update.pageviewHits ?? Number(prev.pageview_hits ?? 0),
            orders: update.orders ?? Number(prev.orders ?? 0),
            revenue: update.revenue ?? Number(prev.revenue ?? 0),
            status: update.status ?? prev.status ?? 'selected',
            reason: update.reason ?? prev.reason ?? '',
            generated_at: clock.now(),
          },
        ],
      });
    },

    /**
     * @param {string} batchId
     * @param {number} idsite
     * @param {import('../../../ports/subject.js').SubjectTarget[]} targets
     */
    async writeSubjectTargets(batchId, idsite, targets) {
      if (targets.length === 0) return;
      await client.insert({
        table: `${database}.ae_subject_target`,
        format: 'JSONEachRow',
        values: targets.map((t) => subjectTargetRow(batchId, idsite, t, clock.now())),
      });
      log('writeSubjectTargets', { batchId, idsite, targets: targets.length });
    },

    /** @param {{batchId: string, idsite: number}} key */
    async readSubjectTargets(key) {
      const rows = await readCurrent(
        'ae_subject_target',
        'batch_id = {batchId:UUID} AND idsite = {idsite:UInt32}',
        { batchId: key.batchId, idsite: key.idsite },
      );
      return rows
        .map(fromSubjectTargetRow)
        .sort((a, b) => a.subjectType.localeCompare(b.subjectType) || a.subjectKey.localeCompare(b.subjectKey));
    },

    /**
     * @param {{batchId: string, idsite: number, subjectType: string, subjectKey: string, status?: string, reason?: string}} update
     */
    async updateSubjectTarget(update) {
      const current = await readCurrent(
        'ae_subject_target',
        'batch_id = {batchId:UUID} AND idsite = {idsite:UInt32} AND subject_type = {subjectType:String} AND subject_key = {subjectKey:String}',
        { batchId: update.batchId, idsite: update.idsite, subjectType: update.subjectType, subjectKey: update.subjectKey },
      );
      if (current.length === 0) {
        throw new Error(`subject target ${update.subjectType}:${update.subjectKey} not found`);
      }
      const prev = fromSubjectTargetRow(current[0]);
      await client.insert({
        table: `${database}.ae_subject_target`,
        format: 'JSONEachRow',
        values: [subjectTargetRow(update.batchId, update.idsite, {
          ...prev,
          status: update.status ?? prev.status,
          reason: update.reason ?? prev.reason,
        }, clock.now())],
      });
    },
  };
}
