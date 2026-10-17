import { experimentReadoutRows, lifecycleRow, readExperiments, scanExperiments } from '../_lib/experiment-scan.js';

/**
 * experiment-readout: one experiment subject's lifecycle and readout rows.
 * The readout runs once per site, over every selected experiment (the
 * subjects in ctx.subjects), and each subject takes its own rows from it.
 * Like experiment-analysis, it stores the observed descriptors and the
 * daily ae_experiment_row rows.
 */

const READOUT_MEMO = 'experiment-readout';

export const adapter = {
  id: 'experiment-readout',
  dependsOn: [],
  scope: 'subject',
  subjectTypes: ['experiment'],
  provides: [],

  /**
   * @param {{idsite: number, subjectKey: string, evidence: {experimentKey?: string}}} subject the subject page
   * @param {import('../../ports/dataset.js').RunContext & {subjects?: object[]}} ctx
   */
  async collect(subject, ctx) {
    const readout = await siteReadout(ctx, subject.idsite);
    const key = subject.evidence?.experimentKey;
    const p = readout.plans.find((plan) => plan.exp.key === key);
    if (!p) {
      return { id: adapter.id, rows: [], notes: { experiment_readout_note: `experiment ${key} is not in the scan` } };
    }
    const expRows = readout.rowsByExperiment.get(key) ?? [];
    return {
      id: adapter.id,
      rows: [lifecycleRow(p.exp, true), ...experimentReadoutRows(p, expRows)],
      notes: { ...readout.notes, experiment_rows: expRows.length },
    };
  },
};

/**
 * The readout of the site's selected experiments, kept in the site memo.
 * @param {import('../../ports/dataset.js').RunContext & {subjects?: object[]}} ctx
 * @param {number} idsite
 */
async function siteReadout(ctx, idsite) {
  const memo = ctx.batchNotes?.get(READOUT_MEMO);
  if (memo?.idsite === idsite) return memo.readout;
  const scan = await scanExperiments(ctx, idsite);
  const byKey = new Map(scan.experiments.map((exp) => [exp.key, exp]));
  const chosen = (ctx.subjects ?? []).map((s) => byKey.get(s.evidence?.experimentKey)).filter(Boolean);
  const readout = await readExperiments(ctx, idsite, scan, chosen);
  ctx.batchNotes?.set(READOUT_MEMO, { idsite, readout });
  return readout;
}
