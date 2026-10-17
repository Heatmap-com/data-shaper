import { OrchestratorError } from './errors.js';

/**
 * The host the user named, lower-cased, with any scheme, path, credentials,
 * and trailing dot removed. `www.` is kept: it is part of what they typed.
 */
export function normalizeDomain(input) {
  let host = String(input ?? '').trim().toLowerCase();
  if (!host) throw new OrchestratorError('A domain is required.', { exitCode: 2 });
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.split(/[/?#]/)[0].replace(/\.$/, '');
  if (host.includes('@')) host = host.slice(host.lastIndexOf('@') + 1);
  if (!host || /\s/.test(host) || !host.includes('.')) throw new OrchestratorError(`Not a domain: ${input}`, { exitCode: 2 });
  return host;
}

/** The domain without a leading `www.`, for matching a site however it was typed. */
export function bareDomain(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^www\./, '');
}

/** True when both name the same site, with or without `www.`. */
export function sameDomain(a, b) {
  return bareDomain(a) === bareDomain(b);
}

const hostOf = (url) => bareDomain(String(url ?? '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0]);

/**
 * The one active `default.sites` row whose main URL is this domain. The row
 * comes from the directory as is; nothing is guessed when there is none, or
 * more than one.
 *
 * @param {string} domain
 * @param {Array<{idsite: number, name: string, mainUrl: string, platform?: string, currency?: string, status?: string}>} rows
 * @returns {{row: object}|{problem: string}}
 */
export function chooseDirectoryRow(domain, rows) {
  const matching = rows.filter((row) => hostOf(row.mainUrl) === bareDomain(domain));
  const active = matching.filter((row) => row.status === 'active');
  if (active.length === 1) return { row: active[0] };
  if (active.length > 1) return { problem: `${active.length} active default.sites rows match ${domain} (idsite ${active.map((row) => row.idsite).join(', ')}); name the site in site.json` };
  if (matching.length) return { problem: `${domain} is in default.sites only as ${matching.map((row) => `idsite ${row.idsite} (${row.status || 'no status'})`).join(', ')}, with no active row` };
  return { problem: `no default.sites row has the main URL ${domain}` };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** A directory name as text: `default.sites` stores some names HTML-escaped (`&#039;47` is `'47`). */
export function decodeEntities(value) {
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const point = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  }).trim();
}

/** A site spec from the user's domain and its directory row. */
export function siteFromDirectory(domain, row) {
  const base = siteFromDomain(domain);
  const site = { slug: base.slug, name: decodeEntities(row.name) || base.slug, domain: base.domain, origin: base.origin, idsite: Number(row.idsite) };
  if (row.platform) site.platform = row.platform;
  if (row.currency) site.currency = row.currency;
  return site;
}

/**
 * A site with no `sites/<slug>/site.json`: the domain, its origin, and a slug
 * from the first label of the bare domain (www.shop.example → shop). A slug
 * starts with a letter, so a label that starts with a digit takes `site-`
 * (47brand.com → site-47brand).
 * A bare slug cannot become a site, because nothing says which domain it is.
 */
export function siteFromDomain(selector) {
  if (!String(selector ?? '').includes('.')) {
    throw new OrchestratorError(`no site "${selector}": add orchestration/sites/${selector}/site.json, or name the site by its domain`, { exitCode: 2 });
  }
  const domain = normalizeDomain(selector);
  const label = bareDomain(domain).split('.')[0].replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const slug = /^[a-z]/.test(label) ? label : `site-${label}`;
  return { slug, domain, origin: `https://${domain}/` };
}
