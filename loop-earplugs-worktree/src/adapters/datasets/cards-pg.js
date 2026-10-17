import { buildCards } from './_cards.js';

/**
 * cards-pg: Phase 5 gate-pipeline cards for the PG catalog, including the
 * PG:S12 alias card mirroring PG:A4. The §9.4 gates evaluate from the
 * descriptor snapshot, the page capture and the structural screen before
 * requirement gating; with everything passing the trigger evaluation
 * itself arrives with the trigger module (Phase 10).
 */

export const adapter = {
  id: 'cards-pg',
  dependsOn: ['requirement-status'],
  scope: 'page',
  provides: [],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    return buildCards('PG', ctx, page);
  },
};
