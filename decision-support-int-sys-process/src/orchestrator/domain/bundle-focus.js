/**
 * The analysed page a bundle is allowed to name. An existing site.json focus
 * is kept. Otherwise the page is the analysis batch's primary target.
 */

/**
 * @param {string} url absolute page URL from ae_page_target.url
 * @returns {string} site.json focus path. The site root is "/".
 */
export function focusPath(url) {
  const pathname = new URL(url).pathname || '/';
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

/**
 * @param {{path?: string, idsitehsr?: number, label?: string}|undefined} existing
 * @param {{idsitehsr: number, url: string, pageTitle?: string}|null} page
 * @returns {{path: string, label: string, idsitehsr: number}}
 */
export function resolveFocus(existing, page) {
  if (existing?.path && Number.isInteger(existing.idsitehsr)) {
    return {
      path: existing.path,
      label: existing.label || existing.path,
      idsitehsr: existing.idsitehsr,
    };
  }
  if (!page || !Number.isInteger(page.idsitehsr) || !page.url) {
    throw new Error('site.json has no focus and the analysis batch has no primary page');
  }
  const path = focusPath(page.url);
  return { path, label: page.pageTitle?.trim() || path, idsitehsr: page.idsitehsr };
}

/**
 * @param {object} site
 * @param {{path: string, label: string, idsitehsr: number}} focus
 */
export function withFocus(site, focus) {
  return { ...site, focus: { path: focus.path, label: focus.label, idsitehsr: focus.idsitehsr } };
}
