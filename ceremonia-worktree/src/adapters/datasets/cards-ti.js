import { buildCards } from './_cards.js';

/**
 * cards-ti: Phase 5 gate-pipeline cards for the TI site catalog. G1/G2
 * failures map to 'blocked' (plan §9.4, standards.json gates block); a
 * structural contradiction resolves to 'exclude'. Missing requirements
 * are still listed and never silent.
 */

export const adapter = {
  id: 'cards-ti',
  dependsOn: ['requirement-status'],
  scope: 'page',
  provides: [],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    return buildCards('TI', ctx, page);
  },
};
