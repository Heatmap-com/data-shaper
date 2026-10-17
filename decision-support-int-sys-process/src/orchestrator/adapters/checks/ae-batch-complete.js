import { readFile } from 'node:fs/promises';

/**
 * The batch the stage's command recorded in `batchFile` ({"batchId": ...})
 * is stored as complete with no failed site and no site still waiting. The
 * stored batch decides, so a command that exits 0 over a failed site leaves
 * the stage incomplete.
 *
 * @param {{aeBatches: {getBatch: (batchId: string) => Promise<{status: string, profile?: string,
 *   sitesQueued?: number, sitesAnalyzed?: number, sitesSkipped?: number, sitesFailed?: number} | null>}}} deps
 */
export function createAdapter({ aeBatches }) {
  return {
    id: 'ae-batch-complete',
    validate(spec) {
      return spec.batchFile ? [] : ['needs batchFile'];
    },
    describe(ctx, spec) {
      return `the analysis batch named in ${ctx.render(spec.batchFile)} is stored as complete with no failed site`;
    },
    async evaluate(ctx, spec) {
      const file = ctx.render(spec.batchFile);
      const batchId = await batchIdIn(file);
      if (!batchId) return { ok: false, summary: `no batch id in ${file}`, details: [{ name: 'batch file', ok: false, message: file }] };
      const batch = await aeBatches.getBatch(batchId);
      if (!batch) return { ok: false, summary: `batch ${batchId} is not stored`, details: [{ name: 'ae_batch', ok: false, message: batchId }] };
      const label = `batch ${batchId} (${batch.profile || 'lp'})`;
      const waiting = waitingSites(batch);
      const counts = `${batch.sitesAnalyzed ?? 0} analyzed, ${batch.sitesSkipped ?? 0} skipped, ${batch.sitesFailed ?? 0} failed${waiting > 0 ? `, ${waiting} waiting` : ''}`;
      const details = [
        { name: 'status', ok: batch.status === 'complete', message: batch.status },
        { name: 'failed sites', ok: (batch.sitesFailed ?? 0) === 0, message: String(batch.sitesFailed ?? 0) },
        { name: 'waiting sites', ok: waiting === 0, message: String(waiting) },
      ];
      const ok = details.every((row) => row.ok);
      if (batch.status !== 'complete') return { ok, summary: `${label} is ${batch.status}: ${counts}`, details };
      return { ok, summary: `${label} complete: ${counts}`, details };
    },
  };
}

/**
 * Queued sites the batch neither analyzed, skipped, nor failed: those still
 * awaiting a capture or a descriptor.
 */
function waitingSites(batch) {
  if (typeof batch.sitesQueued !== 'number') return 0;
  return Math.max(0, batch.sitesQueued - (batch.sitesAnalyzed ?? 0) - (batch.sitesSkipped ?? 0) - (batch.sitesFailed ?? 0));
}

/** @param {string} file */
async function batchIdIn(file) {
  try {
    const body = JSON.parse(await readFile(file, 'utf8'));
    return typeof body.batchId === 'string' && body.batchId ? body.batchId : null;
  } catch {
    return null;
  }
}
