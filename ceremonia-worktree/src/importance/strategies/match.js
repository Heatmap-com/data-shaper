/**
 * Interpreter for strategy `match`. Each rule is a conjunction of the fields
 * it sets (tag, role, type). The rule's `kind` is copied onto the element.
 */

/**
 * @param {import('../../ports/importance.js').PageElement[]} elements
 * @param {import('../../ports/importance.js').MatchRule[]} rules
 * @returns {Array<Omit<import('../../ports/importance.js').ImportantElement, 'adapterId'|'priority'>>}
 */
export function matchElements(elements, rules) {
  /** @type {Array<Omit<import('../../ports/importance.js').ImportantElement, 'adapterId'|'priority'>>} */
  const out = [];
  for (const element of elements) {
    const rule = rules.find((candidate) => matches(element, candidate));
    if (!rule) continue;
    out.push({
      selector: element.selector || element.tag,
      kind: rule.kind,
      tag: element.tag,
      text: element.text ?? '',
      href: element.href,
    });
  }
  return out;
}

/**
 * @param {import('../../ports/importance.js').PageElement} element
 * @param {import('../../ports/importance.js').MatchRule} rule
 */
function matches(element, rule) {
  if (!rule.tag && !rule.role && !rule.type) return false;
  if (rule.tag && element.tag !== rule.tag) return false;
  if (rule.role && (element.role ?? '') !== rule.role) return false;
  if (rule.type && (element.type ?? '') !== rule.type) return false;
  return true;
}
