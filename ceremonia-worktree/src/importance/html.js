/**
 * Pull opening tags out of a page so a declarative matcher can see them.
 * Script and style bodies are dropped before the scan.
 */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/**
 * @param {string} html
 * @returns {import('../ports/importance.js').PageElement[]}
 */
export function parseElements(html) {
  const source = String(html ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  /** @type {import('../ports/importance.js').PageElement[]} */
  const elements = [];
  /** @type {Record<string, number>} */
  const seen = {};
  const open = /<([a-zA-Z][\w:-]*)\b([^>]*)>/g;
  let match = open.exec(source);
  while (match) {
    const tag = match[1].toLowerCase();
    const attrs = match[2] ?? '';
    const start = match.index + match[0].length;
    seen[tag] = (seen[tag] ?? 0) + 1;
    const id = attr(attrs, 'id');
    const className = attr(attrs, 'class');
    const href = attr(attrs, 'href');
    const type = attr(attrs, 'type')?.toLowerCase();
    const role = attr(attrs, 'role')?.toLowerCase();
    const value = attr(attrs, 'value');
    let text = '';
    if (!VOID.has(tag)) {
      const close = source.slice(start).search(new RegExp(`</${tag}\\s*>`, 'i'));
      const raw = close >= 0 ? source.slice(start, start + close) : '';
      text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    } else if (value) {
      text = value.trim();
    }
    const element = { tag, role, type, id, className, href, text };
    element.selector = selectorFor(element, seen[tag]);
    elements.push(element);
    match = open.exec(source);
  }
  return elements;
}

/** @param {string} attrs @param {string} name */
function attr(attrs, name) {
  const found = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  if (!found) return undefined;
  return found[1] ?? found[2] ?? found[3];
}

/**
 * @param {import('../ports/importance.js').PageElement} element
 * @param {number} nth
 */
function selectorFor(element, nth) {
  if (element.selector) return element.selector;
  if (element.id && /^[A-Za-z][\w-]*$/.test(element.id)) return `#${element.id}`;
  const cls = element.className?.split(/\s+/).find((part) => /^[A-Za-z][\w-]*$/.test(part));
  if (cls) return `${element.tag}.${cls}`;
  if (element.tag === 'a' && element.href) return `a[href="${element.href.replace(/"/g, '\\"')}"]`;
  if (element.tag === 'input' && element.type) return `input[type="${element.type}"]`;
  return `${element.tag}:nth-of-type(${nth})`;
}
