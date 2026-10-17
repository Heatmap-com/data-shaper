/**
 * The qualifier's page as the site's primary target.
 * @param {import('../../ports/qualifier.js').Qualification} qualification
 * @returns {import('../../ports/persistence.js').AePageTarget}
 */
export function primaryTarget(qualification) {
  return {
    idsitehsr: Number(qualification.idsitehsr),
    url: qualification.url ?? '',
    pageTitle: qualification.evidence?.title ?? '',
    pageType: qualification.pageType ?? '',
    role: 'primary',
    selectionReason: 'qualifier choice',
    entrySessions: qualification.entrySessions ?? 0,
    orders: qualification.orders ?? 0,
    revenue: qualification.revenue ?? 0,
  };
}
