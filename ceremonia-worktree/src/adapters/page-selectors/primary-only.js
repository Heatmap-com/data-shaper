import { primaryTarget } from '../_lib/page-targets.js';

/**
 * Page selector: the qualifier's landing page as the site's single primary
 * target (plan §9.2 stage 1, Phase 2: max_pages_per_site = 1). Sister and
 * template-member selection is Phase 3; this adapter exists so the runner
 * already talks to a PageSelectorPort and Phase 3 is a new file in this
 * folder, not a runner change.
 */

/** @type {import('../../ports/page-selector.js').PageSelectorPort} */
export const adapter = {
  id: 'primary-only',

  async select(site, qualification) {
    return [primaryTarget(qualification)];
  },
};
