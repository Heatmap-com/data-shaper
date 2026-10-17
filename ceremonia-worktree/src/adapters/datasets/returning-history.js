/**
 * returning-history: placeholder for H27 cross-session returning history.
 * No stable visitor id exists (D-02: udp_hsrce_pageviews.visitor_id is a
 * per-session token), so this dataset emits no rows and overrides the
 * presence-based requirement status with an explicit missing entry.
 * Returning-visitor strategies read the visitor_returning flag only
 * (page-segment-weekly) until the tracker adds a stable visitor key.
 */

export const adapter = {
  id: 'returning-history',
  dependsOn: [],
  scope: 'page',
  provides: [],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    void page;
    void ctx;
    return {
      id: adapter.id,
      rows: [],
      requirements: [
        {
          key: 'H27',
          status: 'missing',
          rowCount: 0,
          detail:
            'no_stable_visitor_id (decision docs/decisions/2026-10-04-d02-browser-and-visitor-id.md)',
        },
      ],
      notes: {
        returning_fallback:
          'returning-visitor strategies read the visitor_returning flag only (partial)',
      },
    };
  },
};
