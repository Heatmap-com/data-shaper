/**
 * Some stores record product titles with the JSON backslashes stripped, so
 * `Cóctel` arrives as `Cu00f3ctel`. This restores the code points U+00A0 to
 * U+00FF (accented Latin letters, ñ, ¿, ¡, º), with or without the backslash.
 * Lower code points are left alone, because `u0041` style text is more likely
 * to be a real word or code than a lost `A`.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function repairStrippedEscapes(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/\\?u00([a-f][0-9a-f])/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}
