import { TemplateError } from './errors.js';

const VALUE = /\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g;
const PARTIAL = /\{\{>\s*([a-z0-9][\w./-]*)\s*\}\}/g;

export function lookup(values, dotted) {
  let node = values;
  for (const key of dotted.split('.')) {
    if (node === null || node === undefined || !Object.hasOwn(Object(node), key)) return undefined;
    node = node[key];
  }
  return node;
}

/** The `{{> name}}` partials a template names, as prompt names (`name.md`). */
export function partialNames(text) {
  return [...new Set([...text.matchAll(PARTIAL)].map((match) => `${match[1]}.md`))];
}

/** Strict substitution. A missing key is an error that names the key and the source. */
export function renderValues(text, values, source = 'template') {
  return text.replace(VALUE, (_, key) => {
    const value = lookup(values, key);
    if (value === undefined) throw new TemplateError(`${source}: no value for {{${key}}}`);
    if (value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  });
}

/** Partials first (async, through the caller's lookup), then values. */
export async function renderTemplate(text, values, { source = 'template', loadPartial, depth = 0 } = {}) {
  if (depth > 5) throw new TemplateError(`${source}: partials nest more than 5 deep`);
  let expanded = text;
  for (const [token, name] of [...text.matchAll(PARTIAL)]) {
    if (!loadPartial) throw new TemplateError(`${source}: partial {{> ${name}}} with no loader`);
    const partial = await loadPartial(`${name}.md`);
    const body = await renderTemplate(partial.body, values, { source: partial.file, loadPartial, depth: depth + 1 });
    expanded = expanded.replace(token, body);
  }
  return renderValues(expanded, values, source);
}

export function parseFrontMatter(raw) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) return { meta: {}, body: raw };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const pair = /^([a-zA-Z_][\w-]*):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (pair) meta[pair[1]] = pair[2];
  }
  return { meta, body: raw.slice(match[0].length) };
}
