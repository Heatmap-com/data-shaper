import { funnelCells } from '../_lib/funnel-reach.js';
import { stepRows } from '../_lib/site-sessions.js';

/**
 * funnel-steps: one funnel subject's ordered reach over the window's
 * sessions. Per (week, bot filter), with an `all` week, each step's
 * sessions that reached it in order, the share that continued from the step
 * before, the median minutes from the step before, and the orders, revenue,
 * and conversion of the sessions that reached it. The steps come from the
 * subject's evidence; funnel-sequence-weekly keeps the page funnel.
 */

export const adapter = {
  id: 'funnel-steps',
  dependsOn: [],
  scope: 'subject',
  subjectTypes: ['funnel'],
  provides: ['H12'],

  /**
   * @param {{idsite: number, evidence: {steps?: string[]}}} subject the subject page
   * @param {import('../../ports/dataset.js').RunContext} ctx
   */
  async collect(subject, ctx) {
    const steps = subject.evidence?.steps ?? [];
    const cells = await funnelCells(ctx, subject.idsite, steps);
    return {
      id: adapter.id,
      rows: stepRows(cells, steps, { minutes: true }),
      notes: { funnel_steps: steps.join(' > '), funnel_order: 'steps in order, other events between them allowed' },
    };
  },
};
