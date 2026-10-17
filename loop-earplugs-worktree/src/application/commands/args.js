const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `--flag value` pairs; a flag with no value, or followed by another flag, is `'true'`. */
export function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = 'true';
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

export function parseList(value) {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A flag given with a value, as opposed to a bare `--flag`. */
export const valueOf = (flags, name) => (flags[name] && flags[name] !== 'true' ? flags[name] : undefined);

/** `--sites 1,2` as idsites; every entry must be a positive integer. */
export function idsites(value) {
  return parseList(value).map((raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--sites: "${raw}" is not a positive integer idsite`);
    return n;
  });
}

/**
 * What the site source lists: the idsites in `flags[listFlag]`, or the
 * `--platform` and `--status` (shopify and active when not given).
 */
export function runSites(flags, listFlag = 'sites') {
  return {
    ...(flags[listFlag] ? { idsites: idsites(flags[listFlag]) } : {}),
    platform: flags.platform ?? 'shopify',
    status: flags.status ?? 'active',
  };
}

export function oneSite(flags, command) {
  const sites = parseList(flags.sites);
  if (sites.length !== 1) throw new Error(`--${command} requires --sites with one idsite`);
  return Number(sites[0]);
}

export function window(flags, command) {
  const windowStart = flags['window-start'];
  const windowEnd = flags['window-end'];
  if (!ISO_DAY.test(windowStart ?? '') || !ISO_DAY.test(windowEnd ?? '')) {
    throw new Error(`--${command} requires --window-start and --window-end as YYYY-MM-DD`);
  }
  if (windowStart > windowEnd) throw new Error('--window-start must be on or before --window-end');
  return { windowStart, windowEnd };
}

export function positiveInt(raw, name) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

export function wholeNumber(raw, name) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a whole number`);
  return value;
}

export const ok = (output) => ({ ok: true, output });
export const failed = (errors) => ({ ok: false, errors });
