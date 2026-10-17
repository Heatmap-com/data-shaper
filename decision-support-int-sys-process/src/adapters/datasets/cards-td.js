import { buildCards } from './_cards.js';

/**
 * cards-td: Phase 5 gate-pipeline cards for the TD site catalog. G1/G2
 * failures map to 'blocked'; an unknown (low-confidence) descriptor field
 * caps confidence instead (B16 'confidence_cap'). TD:FIX and TD:F-ROUTE
 * are fix rows (plan §5.5), not strategies; they get cards with the
 * Phase 3 fix machinery.
 */

export const adapter = {
  id: 'cards-td',
  dependsOn: ['requirement-status'],
  scope: 'page',
  provides: [],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    return buildCards('TD', ctx, page);
  },
};
