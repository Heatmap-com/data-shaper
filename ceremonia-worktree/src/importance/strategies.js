import { matchElements } from './strategies/match.js';

/**
 * Interpreters keyed by descriptor.strategy. A new way of deciding importance
 * is registered here; the adapter file stays a descriptor.
 */
export const strategies = {
  /**
   * @param {import('../ports/importance.js').ImportanceDescriptor} descriptor
   * @param {import('../ports/importance.js').PageElement[]} elements
   */
  match(descriptor, elements) {
    return matchElements(elements, descriptor.select ?? []);
  },
};
