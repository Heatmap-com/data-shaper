/**
 * Stable JSON: object keys sorted at every depth, so two values compare
 * equal as text only when they are equal as data.
 * @param {unknown} value
 */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(/** @type {object} */ (value)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
