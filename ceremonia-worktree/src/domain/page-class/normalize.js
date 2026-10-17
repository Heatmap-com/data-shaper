const SCHEME_HOST = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i;

/**
 * Some HSR page rules store URLs as JSON string bodies, `https:\/\/host\/products\/C\u00f3ctel`.
 * Decode them. A body that is not valid JSON keeps its text with `\/` turned into `/`.
 *
 * @param {unknown} url
 * @returns {string}
 */
export function normalizeUrl(url) {
  if (url === null || url === undefined) return '';
  const text = String(url);
  if (!text.includes('\\')) return text;
  try {
    return JSON.parse(`"${text}"`);
  } catch {
    return text.replaceAll('\\/', '/');
  }
}

/**
 * The lower-cased path that page rules match: scheme and host, query, and
 * fragment removed. `https://x.com` gives `''`, and `/cart/` keeps its slash.
 *
 * Pass `normalize: false` when the text is already normalized, as pathSql takes.
 *
 * @param {unknown} url
 * @param {{normalize?: boolean}} [options]
 */
export function pathOf(url, { normalize = true } = {}) {
  const text = normalize ? normalizeUrl(url) : String(url ?? '');
  return text.split('?', 1)[0].split('#', 1)[0].replace(SCHEME_HOST, '').toLowerCase();
}

/** SQL twin of normalizeUrl. JSONExtractString returns '' for a body that is not valid JSON. */
export function normalizedUrlSql(urlExpr) {
  const text = `ifNull(${urlExpr}, '')`;
  const decoded = `JSONExtractString(concat('"', ${text}, '"'))`;
  return `if(position(${text}, '\\\\') > 0, if(${decoded} != '', ${decoded}, replaceAll(${text}, '\\\\/', '/')), ${text})`;
}

/** SQL twin of pathOf. Pass `normalize: false` when the expression is already normalized. */
export function pathSql(urlExpr, { normalize = true } = {}) {
  const text = normalize ? normalizedUrlSql(urlExpr) : `ifNull(${urlExpr}, '')`;
  return `lowerUTF8(replaceRegexpOne(splitByChar('#', splitByChar('?', ${text})[1])[1], '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]*', ''))`;
}
