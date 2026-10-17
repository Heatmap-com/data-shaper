/**
 * A load the datasets of one page share (its clicks, pageview sequences,
 * session tags, viewport heights), made once per page. The page context's
 * `pageNotes` holds it until the page's datasets finish; a context without
 * one keeps it with the site's notes under the same per-page key.
 *
 * @template T
 * @param {import('../../ports/dataset.js').RunContext} ctx
 * @param {string} key includes the page
 * @param {() => Promise<T>} load
 * @returns {Promise<T>}
 */
export function pageMemo(ctx, key, load) {
  const notes = ctx.pageNotes ?? ctx.batchNotes;
  if (notes.has(key)) return notes.get(key);
  const pending = load();
  notes.set(key, pending);
  return pending;
}
