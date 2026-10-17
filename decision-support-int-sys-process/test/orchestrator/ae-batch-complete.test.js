import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAdapter } from '../../src/orchestrator/adapters/checks/ae-batch-complete.js';

/**
 * The analysis stage is complete when the batch its command wrote to the
 * batch file is stored as complete with no failed site. The check reads the
 * stored batch, so the command's exit code never decides it.
 */

const BATCH = '6b5f8c7f-1ff8-46cf-9279-ef04a69a61c4';

async function ctxWith(body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ae-batch-complete-'));
  if (body !== undefined) await writeFile(path.join(dir, 'batch.json'), typeof body === 'string' ? body : JSON.stringify(body));
  return { render: (text) => text.replace('{{run.dir}}', dir), values: { site: { idsite: 4879 } } };
}

const reader = (batches) => ({ async getBatch(id) { return batches[id] ?? null; } });
const SPEC = { use: 'ae-batch-complete', batchFile: '{{run.dir}}/batch.json' };

describe('the ae-batch-complete check', () => {
  it('passes a stored batch that completed with no failed site', async () => {
    const check = createAdapter({ aeBatches: reader({ [BATCH]: { status: 'complete', sitesQueued: 1, sitesAnalyzed: 1, sitesSkipped: 0, sitesFailed: 0, profile: 'pdp' } }) });
    const verdict = await check.evaluate(await ctxWith({ batchId: BATCH }), SPEC);
    expect(verdict).toMatchObject({ ok: true, summary: `batch ${BATCH} (pdp) complete: 1 analyzed, 0 skipped, 0 failed` });
  });

  it('fails a batch with a failed site, a running batch, and a batch the store lacks', async () => {
    const check = createAdapter({
      aeBatches: reader({
        a: { status: 'complete', sitesAnalyzed: 0, sitesSkipped: 0, sitesFailed: 1, profile: 'lp' },
        b: { status: 'running', sitesAnalyzed: 0, sitesSkipped: 0, sitesFailed: 0, profile: 'lp' },
      }),
    });
    expect((await check.evaluate(await ctxWith({ batchId: 'a' }), SPEC)).ok).toBe(false);
    expect((await check.evaluate(await ctxWith({ batchId: 'b' }), SPEC)).summary).toMatch(/batch b \(lp\) is running/);
    expect((await check.evaluate(await ctxWith({ batchId: 'c' }), SPEC)).summary).toMatch(/batch c is not stored/);
  });

  it('fails a complete batch that leaves a site waiting for its capture', async () => {
    const check = createAdapter({ aeBatches: reader({ [BATCH]: { status: 'complete', sitesQueued: 1, sitesAnalyzed: 0, sitesSkipped: 0, sitesFailed: 0, profile: 'lp' } }) });
    const verdict = await check.evaluate(await ctxWith({ batchId: BATCH }), SPEC);
    expect(verdict.ok).toBe(false);
    expect(verdict.summary).toBe(`batch ${BATCH} (lp) complete: 0 analyzed, 0 skipped, 0 failed, 1 waiting`);
    expect(verdict.details.find((row) => row.name === 'waiting sites')).toEqual({ name: 'waiting sites', ok: false, message: '1' });
  });

  it('fails when the command wrote no batch file', async () => {
    const check = createAdapter({ aeBatches: reader({}) });
    const verdict = await check.evaluate(await ctxWith(undefined), SPEC);
    expect(verdict.ok).toBe(false);
    expect(verdict.summary).toMatch(/no batch id in .*batch\.json/);
  });

  it('names a spec without a batch file', () => {
    expect(createAdapter({ aeBatches: reader({}) }).validate({ use: 'ae-batch-complete' })).toEqual(['needs batchFile']);
  });
});
