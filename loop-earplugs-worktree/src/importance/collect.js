import { parseElements } from './html.js';
import { strategies } from './strategies.js';

/**
 * Run discovered descriptors in priority order. Each adapter adds the
 * selectors it considers important that no earlier adapter has claimed.
 *
 * @param {import('../ports/importance.js').ImportanceDescriptor[]} adapters
 * @param {import('../ports/importance.js').ImportanceSource} source
 * @returns {import('../ports/importance.js').ImportantElement[]}
 */
export function collectImportant(adapters, source) {
  const elements = source.elements ?? parseElements(source.html ?? '');
  /** @type {import('../ports/importance.js').ImportantElement[]} */
  const found = [];
  const claimed = new Set();
  for (const adapter of adapters) {
    const interpret = strategies[adapter.strategy];
    if (!interpret) {
      throw new Error(`importance adapter "${adapter.id}" uses unknown strategy "${adapter.strategy}"`);
    }
    for (const element of interpret(adapter, elements)) {
      if (claimed.has(element.selector)) continue;
      claimed.add(element.selector);
      found.push({ ...element, adapterId: adapter.id, priority: adapter.priority });
    }
  }
  return found;
}
