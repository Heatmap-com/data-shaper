import { readFileSync } from 'node:fs';

/**
 * The DVF homepage proof the trend check used to run in production: the
 * dresses carousel "next" button is clicked on desktop and tablet only, and
 * the section 5 link draws more mobile sessions than desktop ones. The
 * selectors are DVF's seeds in orchestration/sites/dvf/trend-seeds.json.
 */

const seeds = JSON.parse(readFileSync(new URL('../../orchestration/sites/dvf/trend-seeds.json', import.meta.url), 'utf8')).selectors;

export const DVF_HOME = seeds[0];
export const DVF_DRESSES_NEXT = DVF_HOME.trendSelectors[1];
export const DVF_SECTION5 = DVF_HOME.trendSelectors[4];

function selectorSessions(rows, selector, viewport) {
  return rows
    .filter((row) => (
      row.rowKey === 'selector'
      && row.rowKey1 === selector
      && row.viewportType === viewport
      && row.segment === 'all'
      && row.segmentValue === 'all'
    ))
    .reduce((sum, row) => sum + row.sessions, 0);
}

/**
 * The proof's failures for these trend rows; empty when it holds.
 * @param {import('../../src/ports/persistence.js').AeTrendRow[]} rows
 * @returns {string[]}
 */
export function dvfProofErrors(rows) {
  const errors = [];
  const desktop = selectorSessions(rows, DVF_DRESSES_NEXT, 'desktop');
  const tablet = selectorSessions(rows, DVF_DRESSES_NEXT, 'tablet');
  const mobile = selectorSessions(rows, DVF_DRESSES_NEXT, 'mobile');
  if (!(desktop > 0 && tablet > 0 && mobile === 0)) {
    errors.push(`dresses next expected desktop and tablet clicks and no mobile clicks, got ${desktop}/${tablet}/${mobile}`);
  }
  const sectionMobile = selectorSessions(rows, DVF_SECTION5, 'mobile');
  const sectionDesktop = selectorSessions(rows, DVF_SECTION5, 'desktop');
  if (!(sectionMobile > sectionDesktop)) {
    errors.push(`section 5 link expected more mobile sessions than desktop, got mobile ${sectionMobile} desktop ${sectionDesktop}`);
  }
  return errors;
}
