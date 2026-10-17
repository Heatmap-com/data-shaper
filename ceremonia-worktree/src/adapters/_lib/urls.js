/**
 * idsitehsr → {url, title} for a site, memoized on ctx.batchNotes so the
 * page selectors and the qualifier's approach share one lookup shape.
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @returns {Promise<Map<string, {url: string, title: string}>>} key: idsitehsr as string
 */
export async function fetchHsrPages(ctx, idsite) {
  const memoKey = `url-pages:${idsite}`;
  if (ctx.batchNotes.has(memoKey)) return ctx.batchNotes.get(memoKey);

  const load = (async () => {
    const rows = await ctx.gateway.query(
      `SELECT toString(idsitehsr) AS hsr, any(screenshot_url) AS url, any(name) AS title
         FROM default.site_hsr
        WHERE idsite = {idsite:UInt32}
        GROUP BY idsitehsr`,
      { idsite },
      'urls:site-hsr-pages',
    );
    /** @type {Map<string, {url: string, title: string}>} */
    const pages = new Map();
    for (const r of rows) {
      pages.set(String(r.hsr), { url: String(r.url ?? ''), title: String(r.title ?? '') });
    }
    return pages;
  })();

  ctx.batchNotes.set(memoKey, load);
  return load;
}

/**
 * idsitehsr → screenshot_url for a site, memoized on ctx.batchNotes so
 * entry-by-channel and nav-next-page share one lookup.
 *
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {number} idsite
 * @returns {Promise<Map<string, string>>} key: idsitehsr as string
 */
export async function fetchHsrUrls(ctx, idsite) {
  const memoKey = `urls:${idsite}`;
  if (ctx.batchNotes.has(memoKey)) return ctx.batchNotes.get(memoKey);

  const load = (async () => {
    const rows = await ctx.gateway.query(
      `SELECT toString(idsitehsr) AS hsr, any(screenshot_url) AS url
         FROM default.site_hsr
        WHERE idsite = {idsite:UInt32}
        GROUP BY idsitehsr`,
      { idsite },
      'urls:site-hsr',
    );
    /** @type {Map<string, string>} */
    const urls = new Map();
    for (const r of rows) urls.set(r.hsr, String(r.url ?? ''));
    return urls;
  })();

  ctx.batchNotes.set(memoKey, load);
  return load;
}
