import { pageType } from '../../page-type.js';
import { reachCells, siteMemo, siteSessions } from './site-sessions.js';
import { fetchHsrUrls } from './urls.js';

/**
 * Page-type paths: each session's first pageviews as page types, with a
 * run of one type collapsed to one step (product, product, cart reads as
 * product>cart). Journey subjects are path templates over these types, and
 * a session follows a template to step i when its path starts with the
 * template's steps 0..i.
 */

/** The pageviews read per session; a path holds at most MAX_STEPS types. */
const MAX_PAGEVIEWS = 12;
export const MAX_STEPS = 6;

/** The page types a template may name: the page classifier's types. */
export const PATH_TYPES = Object.freeze(['home', 'product', 'collection', 'cart', 'search', 'content', 'checkout', 'account', 'other', 'unknown']);

export const PATH_SEPARATOR = '>';

/**
 * Parses a template such as "home>collection>product".
 * @param {string} text
 * @returns {string[]}
 */
export function parsePath(text) {
  const steps = String(text).split(PATH_SEPARATOR).map((s) => s.trim()).filter(Boolean);
  const unknown = steps.filter((s) => !PATH_TYPES.includes(s));
  if (unknown.length > 0) throw new Error(`journey path "${text}" names unknown page types ${unknown.join(', ')}; known: ${PATH_TYPES.join(', ')}`);
  if (steps.length < 2) throw new Error(`journey path "${text}" needs two or more steps`);
  if (steps.length > MAX_STEPS) throw new Error(`journey path "${text}" has more than ${MAX_STEPS} steps`);
  return steps;
}

/**
 * The window's typed paths per visit.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @returns {Promise<Map<string, string[]>>}
 */
export function sessionPaths(ctx, idsite) {
  return siteMemo(ctx, 'session-paths', idsite, async () => {
    const [rows, urls] = await Promise.all([
      ctx.gateway.query(
        `SELECT toString(idvisit) AS idvisit,
                arrayMap(x -> x.3, arraySlice(arraySort(groupArray((server_time, idloghsr, toString(idsitehsr)))), 1, {maxPageviews:UInt8})) AS hsrs
           FROM default.udp_hsrce_pageviews
          WHERE idsite = {idsite:UInt32} AND server_date BETWEEN {w0:Date} AND {w1:Date}
          GROUP BY idvisit`,
        { idsite, w0: ctx.windowStart, w1: ctx.windowEnd, maxPageviews: MAX_PAGEVIEWS },
        'journey:paths',
      ),
      fetchHsrUrls(ctx, idsite),
    ]);
    /** @type {Map<string, string[]>} */
    const byVisit = new Map();
    for (const r of rows) byVisit.set(r.idvisit, typedPath(r.hsrs ?? [], urls));
    return byVisit;
  });
}

/**
 * @param {string[]} hsrs in pageview order
 * @param {Map<string, string>} urls
 */
export function typedPath(hsrs, urls) {
  const path = [];
  for (const hsr of hsrs) {
    const type = pageType(urls.get(String(hsr)) ?? '');
    if (path[path.length - 1] !== type) path.push(type);
    if (path.length === MAX_STEPS) break;
  }
  return path;
}

/**
 * How many of the template's steps the path opens with.
 * @param {string[]} path
 * @param {string[]} steps
 */
export function prefixReach(path, steps) {
  let i = 0;
  while (i < steps.length && path[i] === steps[i]) i += 1;
  return i;
}

/**
 * The reach cells of one template over the site's sessions.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @param {string[]} steps
 */
export async function pathCells(ctx, idsite, steps) {
  const [sessions, paths] = await Promise.all([siteSessions(ctx, idsite), sessionPaths(ctx, idsite)]);
  return reachCells(sessions.values(), steps.length, (s) => ({ reached: prefixReach(paths.get(s.idvisit) ?? [], steps) }));
}
