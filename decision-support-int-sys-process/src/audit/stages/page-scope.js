import { createTemplateClassifier } from '../classify.js';

/**
 * Classified idsitehsr sets. Queries use these to prune log_hsr on its
 * leading key. An empty template list means that template has no pages.
 * @param {{query: Function}} gateway
 * @param {number} idsite
 * @param {Array<{pattern: string, template: string}>} rules
 */
export async function loadPageScope(gateway, idsite, rules) {
  const rows = await gateway.query(
    `SELECT toString(idsitehsr) AS idsitehsr, any(screenshot_url) AS url
       FROM default.site_hsr
      WHERE idsite = {idsite:UInt32}
      GROUP BY idsitehsr`,
    { idsite },
    'audit:pages',
  );
  /** @type {Record<string, number[]>} */
  const byTemplate = {};
  const classify = createTemplateClassifier(rules);
  for (const row of rows) {
    const template = classify(row.url);
    if (!byTemplate[template]) byTemplate[template] = [];
    byTemplate[template].push(Number(row.idsitehsr));
  }
  return { byTemplate };
}
