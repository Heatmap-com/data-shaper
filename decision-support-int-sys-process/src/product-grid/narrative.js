/**
 * The sentences grid flags are written in, and the order a block's
 * narrative reads them.
 */

/**
 * @param {number} shareValue
 */
export function pct(shareValue) {
  return `${Math.round(shareValue * 100)}%`;
}

/**
 * @param {object} prior
 */
export function priorPhrase(prior) {
  if (!prior) return 'No prior';
  if (prior.priorScope === 'same_page_blocks') return 'The prior is the other block on this page';
  if (prior.priorScope === 'other_pages') return 'The prior is other pages of this layout';
  return 'No prior';
}

/**
 * @param {object[]} flags
 */
export function narrativeOf(flags) {
  const order = { diagnose: 0, test: 1, watch: 2 };
  return flags
    .filter((flag) => flag.inNarrative && !flag.insufficient)
    .sort((a, b) => order[a.action] - order[b.action] || b.priority - a.priority)
    .map((flag) => flag.narrative)
    .join(' ');
}
