import { primaryTarget } from '../_lib/page-targets.js';
import { pageSubject } from '../_lib/subject-candidates.js';

/**
 * The qualifier's page as the site's one page subject: primary-only as a
 * subject selector. It reads nothing, and takes no criteria.
 * @type {import('../../ports/subject.js').SubjectSelectorPort}
 */
export const adapter = {
  id: 'page-primary',
  subjectType: 'page',

  async select(site, qualification) {
    if (!qualification) throw new Error('page-primary selects the qualifier page, and the profile ran no qualifier');
    return [pageSubject(primaryTarget(qualification))];
  },
};
