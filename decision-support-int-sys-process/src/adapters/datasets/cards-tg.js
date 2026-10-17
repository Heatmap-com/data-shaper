import { buildCards } from './_cards.js';

/**
 * cards-tg: Phase 5 gate-pipeline cards for the TG site catalog. G1/G2
 * failures map to 'blocked'; an unresolvable descriptor field set gives
 * the TG-only structural_state 'unknown' (B16), never a silent card.
 */

export const adapter = {
  id: 'cards-tg',
  dependsOn: ['requirement-status'],
  scope: 'page',
  provides: [],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    return buildCards('TG', ctx, page);
  },
};
