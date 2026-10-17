/**
 * Checks resolved parameters against a spec: every key known, every value
 * of its kind. Shared by the quality methods and triage.
 *
 * @typedef {{type: 'number', min?: number, max?: number, integer?: boolean, nullable?: boolean}
 *   | {type: 'enum', values: readonly string[]} | {type: 'strings'} | {type: 'object', keys: Record<string, ParamSpec>}} ParamSpec
 */

/**
 * @param {Record<string, unknown>} params
 * @param {Record<string, ParamSpec>} spec
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function checkParams(params, spec, prefix = '') {
  const problems = [];
  for (const [key, value] of Object.entries(params ?? {})) {
    const at = `${prefix}${key}`;
    const rule = spec[key];
    if (!rule) {
      problems.push(`unknown parameter ${at} (${Object.keys(spec).map((name) => `${prefix}${name}`).join(', ')})`);
      continue;
    }
    if (rule.type === 'number') {
      if (value === null && rule.nullable) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(`${at} must be a number`);
      else if (rule.integer && !Number.isInteger(value)) problems.push(`${at} must be a whole number`);
      else if (rule.min !== undefined && value < rule.min) problems.push(`${at} must be at least ${rule.min}`);
      else if (rule.max !== undefined && value > rule.max) problems.push(`${at} must be at most ${rule.max}`);
    } else if (rule.type === 'enum') {
      if (!rule.values.includes(/** @type {string} */ (value))) problems.push(`${at} must be one of ${rule.values.join(', ')}`);
    } else if (rule.type === 'strings') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) problems.push(`${at} must be a list of strings`);
    } else if (rule.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) problems.push(`${at} must be an object`);
      else problems.push(...checkParams(/** @type {Record<string, unknown>} */ (value), rule.keys, `${at}.`));
    }
  }
  return problems;
}
