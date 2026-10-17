import { randomUUID } from 'node:crypto';
import { isElementClass, TAXONOMY_VERSION } from '../../../domain/taxonomy.js';
import { renderNodeRows } from '../../_lib/render-nodes.js';
import { CLAIM_TTL_MS, aeNow } from './support.js';

/**
 * The CaptureStore role over memory: the capture queue, page captures, renders, and saliency.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/capture-store.js').CaptureStore}
 */
export function createCaptureStore({ store, today }) {
  return {
    /**
     * @param {{idsite: number, idsitehsr: number}} key
     * @returns {Promise<{status: string, taxonomyVersion: string, capturedOn: string, hasRender: boolean, hasSaliency: boolean} | null>}
     */
    async captureStatus(key) {
      const row = store.pageCaptures.get(`${key.idsite}:${key.idsitehsr}`);
      if (!row) return null;
      return {
        status: row.status,
        taxonomyVersion: row.taxonomy_version,
        capturedOn: String(row.captured_on).slice(0, 10),
        hasRender: Number(row.has_render ?? 0) === 1,
        hasSaliency: Number(row.has_saliency ?? 0) === 1,
      };
    },

    /**
     * Idempotent on (idsite, idsitehsr) while a capture is queued, claimed,
     * or done. A failed capture is queued again.
     * @param {import('../../../ports/persistence.js').AeCaptureJob} job
     */
    async enqueueCapture(job) {
      const key = `${job.idsite}:${job.idsitehsr}`;
      const current = store.captureQueue.get(key);
      if (current && current.status !== 'failed') return;
      store.captureQueue.set(key, {
        idsite: job.idsite,
        idsitehsr: job.idsitehsr,
        url: job.url ?? '',
        page_type: job.pageType ?? '',
        device_classes: [...(job.deviceClasses ?? [])],
        want: [...(job.want ?? [])],
        status: 'queued',
        reason: job.reason ?? '',
        requested_on: today(),
        claim_token: '',
        generated_at: aeNow(),
      });
    },

    /**
     * @param {number} [claimTtlMs]
     * @returns {Promise<object | null>} job plus token
     */
    async claimCapture(claimTtlMs = CLAIM_TTL_MS) {
      const staleBefore = Date.now() - claimTtlMs;
      const candidates = [...store.captureQueue.values()]
        .filter(
          (r) =>
            r.status === 'queued' || (r.status === 'claimed' && (r.claimedAt ?? 0) <= staleBefore),
        )
        .sort(
          (a, b) =>
            String(a.requested_on).localeCompare(String(b.requested_on)) ||
            Number(a.idsite) - Number(b.idsite) ||
            Number(a.idsitehsr) - Number(b.idsitehsr),
        );
      const row = candidates[0];
      if (!row) return null;
      const token = randomUUID();
      row.status = 'claimed';
      row.claim_token = token;
      row.claimedAt = Date.now();
      row.generated_at = aeNow();
      return {
        idsite: row.idsite,
        idsitehsr: row.idsitehsr,
        url: row.url,
        pageType: row.page_type,
        deviceClasses: [...row.device_classes],
        want: [...row.want],
        token,
      };
    },

    /**
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
      store.pageCaptures.set(`${done.idsite}:${done.idsitehsr}`, {
        idsite: done.idsite,
        idsitehsr: done.idsitehsr,
        capture_id: captureId,
        url: done.url ?? '',
        status: 'complete',
        taxonomy_version: TAXONOMY_VERSION,
        captured_on: done.capturedOn,
        coverage: JSON.stringify(done.coverage ?? {}),
        has_render: renders.length > 0 || done.hasRender ? 1 : 0,
        has_saliency: done.hasSaliency ? 1 : 0,
        generated_at: aeNow(),
      });
      for (const b of bindings) {
        store.elementBindings.set(`${done.idsite}:${done.idsitehsr}:${b.selector}`, {
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
          generated_at: aeNow(),
        });
      }
      for (const render of renders) {
        const renderKey = `${done.idsite}:${done.idsitehsr}:${render.device_class}`;
        const prev = store.pageRenders.get(renderKey);
        if (prev && String(prev.content_hash ?? '') !== String(render.content_hash)) {
          store.changeLog.set(`${done.idsite}:render_drift:${done.idsitehsr}:${render.device_class}:${String(render.content_hash).slice(0, 12)}`, {
            idsite: done.idsite,
            change_id: `render_drift:${done.idsitehsr}:${render.device_class}:${String(render.content_hash).slice(0, 12)}`,
            change_kind: 'content_drift',
            effective_at: render.rendered_at,
            detected_at: aeNow(),
            source: 'render_diff',
            subject: done.url ?? '',
            detail: JSON.stringify({
              old_hash: prev.content_hash,
              new_hash: render.content_hash,
              device_class: render.device_class,
            }),
            generated_at: aeNow(),
          });
        }
        store.pageRenders.set(renderKey, {
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
          generated_at: aeNow(),
        });
        for (const node of renderNodeRows(done, render, captureId, aeNow())) {
          store.renderNodes.set(`${renderKey}:${node.node_id}`, node);
        }
      }
      const queueRow = store.captureQueue.get(`${done.idsite}:${done.idsitehsr}`);
      if (queueRow) {
        queueRow.status = 'done';
        queueRow.reason = '';
        queueRow.claim_token = '';
        queueRow.generated_at = aeNow();
      }
      const waiting = [...store.pageTargets.values()].filter(
        (row) =>
          Number(row.idsite) === Number(done.idsite) &&
          Number(row.idsitehsr) === Number(done.idsitehsr) &&
          row.status === 'awaiting_capture',
      );
      for (const row of waiting) {
        row.status = 'selected';
        row.generated_at = aeNow();
      }
      const requeued = [];
      const affectedBatches = new Set(waiting.map((row) => row.batch_id));
      for (const batchId of affectedBatches) {
        const remaining = [...store.pageTargets.values()].filter(
          (row) =>
            row.batch_id === batchId &&
            Number(row.idsite) === Number(done.idsite) &&
            row.status === 'awaiting_capture',
        ).length;
        if (remaining > 0) continue;
        const site = store.siteQueue.get(`${batchId}:${done.idsite}`);
        if (!site) continue;
        site.status = 'queued';
        site.reason = 'capture complete';
        site.claim_token = '';
        site.generated_at = aeNow();
        requeued.push({ batchId, idsite: site.idsite, siteName: site.site_name });
      }
      return requeued;
    },

    /** @param {{idsite: number, idsitehsr: number, reason: string}} failure */
    async failCapture(failure) {
      const row = store.captureQueue.get(`${failure.idsite}:${failure.idsitehsr}`);
      if (!row) return;
      row.status = 'failed';
      row.reason = failure.reason.slice(0, 2000);
      row.claim_token = '';
      row.generated_at = aeNow();
    },

    /**
     * Saliency write (D-08): fills saliency on the render-node rows of one
     * device (latest write wins, same as the _current views) and flips the
     * capture row's has_saliency. Mirrors the ClickHouse adapter: only
     * node_ids that already have a row are rewritten, and the mark-done
     * lands on every call because the worker invokes this only after all
     * of the page's devices succeeded. Returns the rows as written.
     * @param {import('../../../ports/persistence.js').AeSaliencyWrite} args
     * @returns {Promise<object[]>}
     */
    async writeSaliency({ idsite, idsitehsr, device_class, nodes, model }) {
      const written = [];
      for (const n of nodes ?? []) {
        const key = `${idsite}:${idsitehsr}:${device_class}:${n.node_id}`;
        const row = store.renderNodes.get(key);
        if (!row) continue;
        row.saliency_share = n.saliency_share;
        row.saliency_quartile = n.saliency_quartile;
        row.saliency_model = model;
        row.generated_at = aeNow();
        written.push({
          node_id: n.node_id,
          saliency_share: row.saliency_share,
          saliency_quartile: row.saliency_quartile,
          saliency_model: model,
        });
      }
      const capture = store.pageCaptures.get(`${idsite}:${idsitehsr}`);
      if (capture) capture.has_saliency = 1;
      return written;
    },
  };
}
