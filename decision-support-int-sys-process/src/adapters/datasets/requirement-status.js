import { loadCatalog } from '../../catalog/index.js';

/**
 * requirement-status: one row per registry code for this page's run. Pure:
 * it does not query the gateway; it reads the datasets the runner already
 * collected (ctx.datasets, keyed by dataset id) and marks each requirement
 * available, partial, unknown_value (operator import) or missing. Cards
 * read this dataset; nothing downstream recomputes availability.
 */

// Mirror of each dataset adapter's `provides` field. Phase 2 replaces this
// static map with provides read from the collected datasets themselves.
export const PROVIDERS = {
  'page-segment-weekly': ['H01', 'H02', 'H23', 'H06', 'H07'],
  'entry-by-channel': ['H03', 'H24'],
  'order-value-hist': ['H14'],
  'page-country': ['H05'],
  'scroll-decile': ['H08'],
  'selector-weekly': ['H09', 'H21'],
  'rage-clicks': ['H10'],
  'nav-next-page': ['H11'],
  'campaign-coverage': ['H03'],
  'campaign-weekly': ['H03', 'H04'],
  'line-items': ['H13'],
  'coverage': ['H28'],
  'strategy-triggers': [],
  'element-binding': ['M05'],
  'exposure-weekly': ['H18', 'T14'],
  'dwell-model-inputs': ['H18'],
  'funnel-sequence-weekly': ['H12'],
  'forms-weekly': ['H19'],
  'journey-weekly': ['H20', 'H04'],
  'viewport-weekly': ['H07'],
  'returning-history': [],
  'recordings-sample': ['H17'],
  'custom-event-inventory': ['H28', 'T21'],
  'page-speed': ['H15', 'A03'],
  'experiments-weekly': ['H16', 'O04'],
  'sister-pages': ['H24'],
  'site-baselines': ['H24'],
  'card-history': ['H26'],
  'render-snapshot': ['M01', 'M02', 'M03', 'M06'],
  'saliency': ['M04'],
  'tap-geometry-weekly': ['H22'],
  'template-weekly': ['H25'],
  'kind-fleet-weekly': ['H25'],
  'tool-registry': ['V13', 's16'],
  'ad-creative': ['A01'],
};

export const adapter = {
  id: 'requirement-status',
  // Read after the page datasets that provide requirement codes. Site-scoped
  // providers are folded in by the runner once that phase has finished.
  dependsOn: [
    'page-segment-weekly',
    'entry-by-channel',
    'order-value-hist',
    'page-country',
    'scroll-decile',
    'selector-weekly',
    'rage-clicks',
    'nav-next-page',
    'campaign-coverage',
    'campaign-weekly',
    'line-items',
    'coverage',
    'element-binding',
    'exposure-weekly',
    'dwell-model-inputs',
    'funnel-sequence-weekly',
    'forms-weekly',
    'journey-weekly',
    'viewport-weekly',
    'recordings-sample',
    'custom-event-inventory',
    'page-speed',
    'tap-geometry-weekly',
    'render-snapshot',
    'saliency',
  ],
  scope: 'page',
  provides: [],

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const bundle = loadCatalog();
    const rows = [];
    for (const requirement of bundle.requirements.requirements) {
      let status = 'missing';
      let rowCount = 0;
      let detail = 'no dataset provides this requirement yet';
      if (requirement.mechanism === 'operator') {
        status = 'unknown_value';
        detail = 'operator import required (Phase 5)';
      } else {
        for (const [datasetId, provides] of Object.entries(PROVIDERS)) {
          if (!provides.includes(requirement.key)) continue;
          const dataset = ctx.datasets.get(datasetId);
          if (!dataset) continue;
          rowCount = Array.isArray(dataset.rows) ? dataset.rows.length : 0;
          if (rowCount === 0) {
            status = 'partial';
            detail = `zero rows from ${datasetId}`;
          } else {
            status = 'available';
            detail = '';
          }
          break;
        }
      }
      rows.push({
        dims: { requirement_key: requirement.key, scope_hint: requirement.domain },
        metrics: { status, row_count: rowCount, detail },
      });
    }
    return {
      id: adapter.id,
      rows,
      notes: { requirement_status_version: 1 },
    };
  },
};
