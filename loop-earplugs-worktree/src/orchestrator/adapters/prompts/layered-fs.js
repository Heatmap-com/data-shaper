import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontMatter, partialNames, renderTemplate } from '../../domain/template.js';
import { NotFoundError } from '../../domain/errors.js';

const NAME = /^(system|fallback|primary|report)\/[a-z0-9][a-z0-9-]*\.md$/;

/** sites/<slug>/prompts/<name> over general/prompts/<name>. Front matter `mode` chooses replace, append, or prepend. */
export function createLayeredPromptSource({ root }) {
  return { render, sources };

  async function load(name, site) {
    if (!NAME.test(name)) throw new NotFoundError(`prompt name "${name}" must be <class>/<name>.md`);
    const general = await read(path.join(root, 'general', 'prompts', name));
    const specific = site ? await read(path.join(root, 'sites', site, 'prompts', name)) : null;
    if (!general && !specific) throw new NotFoundError(`no prompt ${name} for ${site ?? 'general'}`);
    if (!specific) return { body: general.body, file: general.file, sources: [general.file] };
    const mode = specific.meta.mode ?? 'replace';
    if (mode === 'replace' || !general) return { body: specific.body, file: specific.file, sources: [specific.file] };
    const body = mode === 'prepend' ? `${specific.body}\n\n${general.body}` : `${general.body}\n\n${specific.body}`;
    return { body, file: `${general.file} + ${specific.file}`, sources: [general.file, specific.file] };
  }

  async function render(name, values, { site } = {}) {
    const top = await load(name, site);
    const used = [...top.sources];
    const text = await renderTemplate(top.body, values, {
      source: top.file,
      loadPartial: async (partial) => {
        const found = await load(partial, site);
        used.push(...found.sources);
        return found;
      },
    });
    return { text, sources: [...new Set(used)] };
  }

  /** Every file the prompt is built from, its partials included, without rendering values. */
  async function sources(name, { site } = {}, seen = new Set([name])) {
    const top = await load(name, site);
    const files = [...top.sources];
    for (const partial of partialNames(top.body)) {
      if (seen.has(partial)) continue;
      seen.add(partial);
      files.push(...(await sources(partial, { site }, seen)));
    }
    return [...new Set(files)];
  }
}

async function read(file) {
  try {
    const { meta, body } = parseFrontMatter(await readFile(file, 'utf8'));
    return { meta, body, file };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
