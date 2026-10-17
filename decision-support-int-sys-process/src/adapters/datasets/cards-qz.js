import { buildCards } from './_cards.js';

/**
 * cards-qz: gate-pipeline cards for the QZ catalog, one per quiz subject.
 * Every QZ strategy needs the quiz events (Q01–Q03), so its cards gate on
 * requirements until the event contract carries a quiz family.
 */

export const adapter = {
  id: 'cards-qz',
  dependsOn: ['requirement-status'],
  scope: 'page',
  provides: [],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    return buildCards('QZ', ctx, page);
  },
};
