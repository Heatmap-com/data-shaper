import { buildCards } from './_cards.js';

/**
 * cards-po: Phase 5 gate-pipeline cards for the PO catalog. The §9.4
 * gates evaluate from the descriptor snapshot, the page capture and the
 * structural screen before requirement gating; with everything passing
 * the trigger evaluation itself arrives with the trigger module
 * (Phase 10).
 */

export const adapter = {
  id: 'cards-po',
  dependsOn: ['requirement-status'],
  scope: 'page',
  provides: [],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    return buildCards('PO', ctx, page);
  },
};
