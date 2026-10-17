import { randomUUID } from 'node:crypto';
import { isElementClass, TAXONOMY_VERSION } from '../../../domain/taxonomy.js';
import { renderNodeRows } from '../../_lib/render-nodes.js';
import { CLAIM_TTL_MS, oneAtATime, staleBeforeCh, clock, toIsoDate } from './support.js';

/**
 * The CaptureStore role over ClickHouse: the capture queue, page captures, renders, and saliency.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/capture-store.js').CaptureStore}
 */
export function createCaptureStore({ client, database, log, run, readCurrent, insertChangeRows }) {
  const serial = oneAtATime();
  return {
    /**
     * @param {{idsite: number, idsitehsr: number}} key
     * @returns {Promise<{status: string, taxonomyVersion: string, capturedOn: string, hasRender: boolean, hasSaliency: boolean} | null>}
     */
    async captureStatus(key) {
      const rows = await run(
        client.query({
          query: `
            SELECT status, taxonomy_version, captured_on, has_render, has_saliency
              FROM ${database}.ae_page_capture_current
             WHERE idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}`,
          query_params: { idsite: key.idsite, idsitehsr: key.idsitehsr },
          format: 'JSONEachRow',
        }),
      );
      if (rows.length === 0) return null;
      const row = rows[0];
      return {
        status: row.status,
        taxonomyVersion: row.taxonomy_version,
        capturedOn: toIsoDate(row.captured_on),
        hasRender: Number(row.has_render ?? 0) === 1,
        hasSaliency: Number(row.has_saliency ?? 0) === 1,
      };
    },

    /**
     * Idempotent on (idsite, idsitehsr) while a capture is queued, claimed,
     * or done. A failed capture is queued again: the page is still not fresh,
     * and leaving the row at 'failed' means the consumer never claims it.
     * @param {import('../../../ports/persistence.js').AeCaptureJob} job
     */
    async enqueueCapture(job) {
      const existing = await readCurrent(
        'ae_capture_queue',
        'idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}',
        { idsite: job.idsite, idsitehsr: job.idsitehsr },
      );
      const current = existing[0];
      if (current && current.status !== 'failed') return;
      await client.insert({
        table: `${database}.ae_capture_queue`,
        format: 'JSONEachRow',
        values: [
          {
            idsite: job.idsite,
            idsitehsr: job.idsitehsr,
            url: job.url ?? '',
            page_type: job.pageType ?? '',
            device_classes: job.deviceClasses ?? [],
            want: job.want ?? [],
            status: 'queued',
            reason: job.reason ?? '',
            requested_on: new Date().toISOString().slice(0, 10),
            claim_token: '',
            generated_at: clock.now(),
          },
        ],
      });
      log('enqueueCapture', { idsite: job.idsite, idsitehsr: job.idsitehsr });
    },

    /**
     * Claims the oldest queued (or stale claimed) capture job exclusively by
     * token, same protocol as claimNextSite, one claim at a time per store.
     * @param {number} [claimTtlMs]
     * @returns {Promise<object | null>} job plus token
     */
    claimCapture(claimTtlMs = CLAIM_TTL_MS) {
      return serial(async () => {
        const candidates = await run(
          client.query({
            query: `
              SELECT *
                FROM ${database}.ae_capture_queue_current
               WHERE status = 'queued'
                  OR (status = 'claimed'
                      AND generated_at <= {staleBefore:String}::DateTime64(3))
               ORDER BY requested_on, idsite, idsitehsr
               LIMIT 1`,
            query_params: { staleBefore: staleBeforeCh(claimTtlMs) },
            format: 'JSONEachRow',
          }),
        );
        const row = candidates[0];
        if (!row) return null;
        const token = randomUUID();
        await client.insert({
          table: `${database}.ae_capture_queue`,
          format: 'JSONEachRow',
          values: [
            {
              idsite: Number(row.idsite),
              idsitehsr: Number(row.idsitehsr),
              url: row.url ?? '',
              page_type: row.page_type ?? '',
              device_classes: row.device_classes ?? [],
              want: row.want ?? [],
              status: 'claimed',
              reason: row.reason ?? '',
              requested_on: toIsoDate(row.requested_on),
              claim_token: token,
              generated_at: clock.now(),
            },
          ],
        });
        const mine = await run(
          client.query({
            query: `
              SELECT claim_token
                FROM ${database}.ae_capture_queue_current
               WHERE idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}`,
            query_params: { idsite: Number(row.idsite), idsitehsr: Number(row.idsitehsr) },
            format: 'JSONEachRow',
          }),
        );
        if (String(mine[0]?.claim_token ?? '') !== token) return null;
        return {
          idsite: Number(row.idsite),
          idsitehsr: Number(row.idsitehsr),
          url: row.url ?? '',
          pageType: row.page_type ?? '',
          deviceClasses: row.device_classes ?? [],
          want: row.want ?? [],
          token,
        };
      });
    },

    /**
     * Validates every binding's element_class against the taxonomy, writes
     * ae_page_capture (status 'complete') and the ae_element_binding rows,
     * then — when renders are present — one ae_page_render row per device
     * class and the ae_render_node rows (one per section and per element,
     * saliency left null for the worker), plus a render-drift ae_change_log
     * row per device whose current content_hash differs (§9.3). Completes
     * the capture_queue row, re-queues every awaiting_capture page_target
     * back to 'selected' and puts each affected site back to 'queued'
     * (reason 'capture complete') once it has no remaining
     * awaiting_capture pages. Returns the re-queued site rows.
     * @param {import('../../../ports/persistence.js').AeCaptureComplete} done
     * @returns {Promise<Array<{batchId: string, idsite: number, siteName: string}>>}
     */
    async completeCapture(done) {
      const bindings = done.bindings ?? [];
      for (const binding of bindings) {
        if (!isElementClass(binding.element_class)) {
          throw new Error(
            `element_class "${binding.element_class}" is not in taxonomy ${TAXONOMY_VERSION}`,
          );
        }
      }
      const renders = done.renders ?? [];
      const captureId = randomUUID();
      const hasRender = renders.length > 0 ? true : Boolean(done.hasRender);
      await client.insert({
        table: `${database}.ae_page_capture`,
        format: 'JSONEachRow',
        values: [
          {
            idsite: done.idsite,
            idsitehsr: done.idsitehsr,
            capture_id: captureId,
            url: done.url ?? '',
            status: 'complete',
            taxonomy_version: TAXONOMY_VERSION,
            captured_on: done.capturedOn,
            coverage: JSON.stringify(done.coverage ?? {}),
            has_render: hasRender ? 1 : 0,
            has_saliency: done.hasSaliency ? 1 : 0,
            generated_at: clock.now(),
          },
        ],
      });
      if (renders.length > 0) {
        for (const render of renders) {
          const prev = (
            await readCurrent(
              'ae_page_render',
              'idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64} AND device_class = {deviceClass:String}',
              { idsite: done.idsite, idsitehsr: done.idsitehsr, deviceClass: render.device_class },
            )
          )[0];
          if (prev && String(prev.content_hash ?? '') !== String(render.content_hash)) {
            await insertChangeRows([
              {
                idsite: done.idsite,
                change_id: `render_drift:${done.idsitehsr}:${render.device_class}:${String(render.content_hash).slice(0, 12)}`,
                change_kind: 'content_drift',
                effective_at: render.rendered_at,
                detected_at: clock.now(),
                source: 'render_diff',
                subject: done.url ?? '',
                detail: {
                  old_hash: prev.content_hash,
                  new_hash: render.content_hash,
                  device_class: render.device_class,
                },
              },
            ]);
          }
          await client.insert({
            table: `${database}.ae_page_render`,
            format: 'JSONEachRow',
            values: [
              {
                idsite: done.idsite,
                idsitehsr: done.idsitehsr,
                device_class: render.device_class,
                capture_id: captureId,
                viewport_w: render.viewport_w,
                viewport_h: render.viewport_h,
                page_height_px: render.page_height_px,
                fold_px: render.fold_px,
                screenshot_uri: render.screenshot_uri ?? '',
                content_hash: render.content_hash,
                dom_hash: render.dom_hash,
                section_order: (render.sections ?? []).map((section) => section.id),
                rendered_at: render.rendered_at,
                renderer_version: render.renderer_version,
                generated_at: clock.now(),
              },
            ],
          });
          await client.insert({
            table: `${database}.ae_render_node`,
            format: 'JSONEachRow',
            values: renderNodeRows(done, render, captureId, clock.now()),
          });
        }
      }
      if (bindings.length > 0) {
        await client.insert({
          table: `${database}.ae_element_binding`,
          format: 'JSONEachRow',
          values: bindings.map((b) => ({
            idsite: done.idsite,
            idsitehsr: done.idsitehsr,
            selector: b.selector,
            element_class: b.element_class,
            element_role: b.element_role ?? '',
            name: b.name ?? '',
            template_family: b.template_family ?? '',
            position_index: b.position_index ?? -1,
            section_id: b.section_id ?? '',
            naming_provenance: b.naming_provenance ?? 'ai',
            ai_confidence: b.ai_confidence ?? 0,
            human_confirmed_by: b.human_confirmed_by ?? '',
            rollup_grain: b.rollup_grain ?? 'selector',
            attention_enrolled: b.attention_enrolled ? 1 : 0,
            taxonomy_version: TAXONOMY_VERSION,
            named_on: b.named_on ?? done.capturedOn,
            generated_at: clock.now(),
          })),
        });
      }
      const queueRow = (
        await readCurrent(
          'ae_capture_queue',
          'idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}',
          { idsite: done.idsite, idsitehsr: done.idsitehsr },
        )
      )[0];
      if (queueRow) {
        await client.insert({
          table: `${database}.ae_capture_queue`,
          format: 'JSONEachRow',
          values: [
            {
              idsite: done.idsite,
              idsitehsr: done.idsitehsr,
              url: queueRow.url ?? '',
              page_type: queueRow.page_type ?? '',
              device_classes: queueRow.device_classes ?? [],
              want: queueRow.want ?? [],
              status: 'done',
              reason: '',
              requested_on: toIsoDate(queueRow.requested_on),
              claim_token: '',
              generated_at: clock.now(),
            },
          ],
        });
      }
      const waiting = await readCurrent(
        'ae_page_target',
        "idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64} AND status = 'awaiting_capture'",
        { idsite: done.idsite, idsitehsr: done.idsitehsr },
      );
      if (waiting.length > 0) {
        await client.insert({
          table: `${database}.ae_page_target`,
          format: 'JSONEachRow',
          values: waiting.map((row) => ({
            batch_id: row.batch_id,
            idsite: Number(row.idsite),
            idsitehsr: Number(row.idsitehsr),
            url: row.url ?? '',
            page_title: row.page_title ?? '',
            page_type: row.page_type ?? '',
            template_family: row.template_family ?? '',
            role: row.role ?? '',
            selection_reason: row.selection_reason ?? '',
            entry_sessions: Number(row.entry_sessions ?? 0),
            pageview_hits: Number(row.pageview_hits ?? 0),
            orders: Number(row.orders ?? 0),
            revenue: Number(row.revenue ?? 0),
            status: 'selected',
            reason: row.reason ?? '',
            generated_at: clock.now(),
          })),
        });
      }
      const requeued = [];
      const affected = [...new Set(waiting.map((row) => `${row.batch_id}|${Number(row.idsite)}`))];
      for (const key of affected) {
        const [batchId, idsite] = [key.slice(0, key.indexOf('|')), Number(key.slice(key.indexOf('|') + 1))];
        const remaining = await run(
          client.query({
            query: `
              SELECT batch_id, count() AS awaiting
                FROM ${database}.ae_page_target_current
               WHERE batch_id = {batchId:UUID} AND idsite = {idsite:UInt32} AND status = 'awaiting_capture'
               GROUP BY batch_id`,
            query_params: { batchId, idsite },
            format: 'JSONEachRow',
          }),
        );
        if (Number(remaining[0]?.awaiting ?? 0) > 0) continue;
        const site = (
          await readCurrent(
            'ae_site_queue',
            'batch_id = {batchId:UUID} AND idsite = {idsite:UInt32}',
            { batchId, idsite },
          )
        )[0];
        if (!site) continue;
        await client.insert({
          table: `${database}.ae_site_queue`,
          format: 'JSONEachRow',
          values: [
            {
              batch_id: batchId,
              idsite,
              site_name: site.site_name ?? '',
              status: 'queued',
              reason: 'capture complete',
              claim_token: '',
              pages_selected: Number(site.pages_selected ?? 0),
              pages_analyzed: Number(site.pages_analyzed ?? 0),
              entry_sessions: Number(site.entry_sessions ?? 0),
              orders: Number(site.orders ?? 0),
              revenue: Number(site.revenue ?? 0),
              generated_at: clock.now(),
            },
          ],
        });
        requeued.push({ batchId, idsite, siteName: site.site_name ?? '' });
      }
      log('completeCapture', {
        idsite: done.idsite,
        idsitehsr: done.idsitehsr,
        bindings: bindings.length,
        renders: renders.length,
        requeued: requeued.length,
      });
      return requeued;
    },

    /** @param {{idsite: number, idsitehsr: number, reason: string}} failure */
    async failCapture(failure) {
      const current = await readCurrent(
        'ae_capture_queue',
        'idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}',
        { idsite: failure.idsite, idsitehsr: failure.idsitehsr },
      );
      const prev = current[0] ?? {};
      await client.insert({
        table: `${database}.ae_capture_queue`,
        format: 'JSONEachRow',
        values: [
          {
            idsite: failure.idsite,
            idsitehsr: failure.idsitehsr,
            url: prev.url ?? '',
            page_type: prev.page_type ?? '',
            device_classes: prev.device_classes ?? [],
            want: prev.want ?? [],
            status: 'failed',
            reason: failure.reason.slice(0, 2000),
            requested_on: toIsoDate(prev.requested_on ?? new Date().toISOString().slice(0, 10)),
            claim_token: '',
            generated_at: clock.now(),
          },
        ],
      });
    },

    /**
     * Saliency write (D-08): re-inserts the ae_render_node rows of one
     * device with saliency filled — a ReplacingMergeTree rewrite of the
     * same ORDER BY keys, untouched geometry preserved — and flips
     * ae_page_capture.has_saliency = 1. One method on purpose: the worker
     * calls it only after every device screenshot of the page succeeded,
     * so the mark-done is never premature on multi-device pages. Model
     * node_ids the page has no row for are ignored. Returns the rows as
     * written.
     * @param {import('../../../ports/persistence.js').AeSaliencyWrite} args
     * @returns {Promise<object[]>}
     */
    async writeSaliency({ idsite, idsitehsr, device_class, nodes, model }) {
      const byNode = new Map((nodes ?? []).map((n) => [n.node_id, n]));
      const current = await readCurrent(
        'ae_render_node',
        'idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64} AND device_class = {deviceClass:String}',
        { idsite, idsitehsr, deviceClass: device_class },
      );
      const values = [];
      const written = [];
      for (const row of current) {
        const hit = byNode.get(row.node_id);
        if (!hit) continue;
        values.push({
          ...row,
          saliency_share: hit.saliency_share,
          saliency_quartile: hit.saliency_quartile,
          saliency_model: model,
          generated_at: clock.now(),
        });
        written.push({
          node_id: row.node_id,
          saliency_share: hit.saliency_share,
          saliency_quartile: hit.saliency_quartile,
          saliency_model: model,
        });
      }
      if (values.length > 0) {
        await client.insert({
          table: `${database}.ae_render_node`,
          format: 'JSONEachRow',
          values,
        });
      }
      const capture = await readCurrent(
        'ae_page_capture',
        'idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}',
        { idsite, idsitehsr },
      );
      if (capture[0]) {
        await client.insert({
          table: `${database}.ae_page_capture`,
          format: 'JSONEachRow',
          values: [{ ...capture[0], has_saliency: 1, generated_at: clock.now() }],
        });
      }
      log('writeSaliency', { idsite, idsitehsr, device_class, nodes: written.length, model });
      return written;
    },
  };
}
