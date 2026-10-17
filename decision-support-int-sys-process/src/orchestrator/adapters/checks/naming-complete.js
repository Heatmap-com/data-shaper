import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** dataset/<idsite>/<kind>/<slug>/ must hold names.json with rows, both renders, and console.json with naming.complete. */
export const adapter = {
  id: 'naming-complete',
  describe(ctx, spec) {
    return `${ctx.render(spec.datasetRoot)}/${ctx.values.site.idsite}/<kind>/${pageSlug(ctx.unit.page.url)}/ has names.json with at least one row, render.desktop.json, render.mobile.json, and console.json containing "naming.complete".`;
  },
  async evaluate(ctx, spec) {
    const root = path.join(ctx.render(spec.datasetRoot), String(ctx.values.site.idsite));
    const slug = pageSlug(ctx.unit.page.url);
    const dir = await findPageDir(root, slug, preferredKind(ctx.unit.page.url));
    if (!dir) return { ok: false, summary: `no dataset folder for ${slug} under ${root}`, details: [{ name: 'folder', ok: false, message: root }] };
    const details = [
      await namesHaveRows(path.join(dir, 'names.json')),
      await exists(path.join(dir, 'render.desktop.json'), 'render.desktop.json'),
      await exists(path.join(dir, 'render.mobile.json'), 'render.mobile.json'),
      await contains(path.join(dir, 'console.json'), 'naming.complete'),
    ];
    const ok = details.every((row) => row.ok);
    return { ok, summary: ok ? `${dir} complete` : `${dir}: ${details.filter((row) => !row.ok).map((row) => row.name).join(', ')} missing`, details };
  },
};

export function pageSlug(url) {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  return segments.at(-1) ?? 'index';
}

function preferredKind(url) {
  const { pathname } = new URL(url);
  if (pathname === '/' || pathname === '') return 'landing';
  if (pathname.includes('/products/')) return 'pdp';
  if (pathname.includes('/collections/')) return 'collection';
  return null;
}

async function findPageDir(root, slug, kind) {
  if (kind && (await isDir(path.join(root, kind, slug)))) return path.join(root, kind, slug);
  let kinds = [];
  try { kinds = await readdir(root); } catch { return null; }
  for (const candidate of kinds.sort()) {
    if (await isDir(path.join(root, candidate, slug))) return path.join(root, candidate, slug);
  }
  return null;
}

async function namesHaveRows(file) {
  try {
    const body = JSON.parse(await readFile(file, 'utf8'));
    const rows = Array.isArray(body) ? body : (body.names ?? body.rows ?? []);
    return { name: 'names.json', ok: rows.length > 0, message: `${rows.length} row(s)` };
  } catch (err) {
    return { name: 'names.json', ok: false, message: err.code ?? err.message };
  }
}

async function exists(file, name) {
  try { return { name, ok: (await stat(file)).size > 0 }; } catch { return { name, ok: false, message: 'missing' }; }
}

async function contains(file, text) {
  try { return { name: 'console.json naming.complete', ok: (await readFile(file, 'utf8')).includes(text) }; } catch { return { name: 'console.json naming.complete', ok: false, message: 'missing' }; }
}

async function isDir(dir) {
  try { return (await stat(dir)).isDirectory(); } catch { return false; }
}
