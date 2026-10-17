/**
 * Element-importance port. An adapter is a descriptor, not a function.
 * Discovery loads every descriptor in the importance directory and runs them
 * in `priority` order: a smaller number runs first. Two descriptors with the
 * same priority run in id order.
 *
 * The first adapter that claims a selector keeps it. A later adapter adds
 * only the selectors that are still open. A more specific adapter therefore
 * uses a lower priority than the broad buttons-and-links baseline (100).
 *
 * `strategy` names the interpreter. `match` applies `select` rules to the
 * elements of a page. A later interpreter (behavioral counts, stored names,
 * a Playwright DOM pass) is a new strategy plus a new descriptor file.
 */

/**
 * @typedef {'button'|'link'} ImportanceKind
 */

/**
 * One declarative match rule. Every field that is set must equal the element.
 * @typedef {Object} MatchRule
 * @property {string} [tag]
 * @property {string} [role]
 * @property {string} [type]
 * @property {ImportanceKind} kind
 */

/**
 * @typedef {Object} ImportanceDescriptor
 * @property {string} id
 * @property {import('../discover.js').AdapterDescriptor} descriptor purpose and the meaning of each element, from the sibling descriptor file
 * @property {number} priority invocation sequence; smaller runs first
 * @property {string} strategy interpreter name
 * @property {MatchRule[]} [select] required when strategy is `match`
 */

/**
 * @typedef {Object} PageElement
 * @property {string} tag
 * @property {string} [role]
 * @property {string} [type]
 * @property {string} [id]
 * @property {string} [className]
 * @property {string} [href]
 * @property {string} [text]
 * @property {string} [selector]
 */

/**
 * @typedef {Object} ImportantElement
 * @property {string} selector
 * @property {ImportanceKind} kind
 * @property {string} tag
 * @property {string} text
 * @property {string} [href]
 * @property {string} adapterId
 * @property {number} priority
 */

/**
 * @typedef {Object} ImportanceSource
 * @property {string} [html]
 * @property {PageElement[]} [elements]
 * @property {number} [idsite]
 * @property {number} [idsitehsr]
 * @property {string} [url]
 */
