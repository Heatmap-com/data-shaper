import { buildCards } from './_cards.js';

/**
 * cards-lp: Phase 5 gate-pipeline cards for the 41 legacy LP strategies.
 * Wraps strategy-triggers unchanged (plan §9.4: LP cards keep the LP
 * rollup rules; LP floors and trigger states are its own G6): with the
 * gates passed and requirements available a card reads its trigger row
 * and keeps its verdict; a gate failure or a missing requirement is
 * conditional and never silent. Replaces strategy-triggers in Phase 2.
 */

export const adapter = {
  id: 'cards-lp',
  dependsOn: ['requirement-status', 'strategy-triggers'],
  scope: 'page',
  provides: [],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    return buildCards('LP', ctx, page);
  },
};
