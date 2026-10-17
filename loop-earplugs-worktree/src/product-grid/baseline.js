/**
 * Leave-one-block-out click rate by device, layout, column, and depth.
 * A carousel prior also splits in-capture from off-screen. The block being
 * judged is excluded. A column is eligible at 20 clicking sessions from the
 * other blocks, the click gate from the anomaly note.
 */

export const PRIOR_CLICK_FLOOR = 20;

/**
 * @param {{layout: string, col: number, depthBand: string, inCapture: number}} cell
 */
export function priorKey(cell) {
  if (cell.layout === 'carousel' || cell.layout === 'fitted_row') {
    return `${cell.layout}|c${cell.col}|${cell.inCapture}`;
  }
  return `${cell.layout}|c${cell.col}|${cell.depthBand}`;
}

/**
 * @param {object[]} blocks classified blocks with cell click totals
 * @returns {Map<string, Map<string, object>>} `${blockId}|${device}` -> prior key -> prior
 */
export function buildPriors(blocks) {
  /** @type {Map<string, Map<string, object>>} */
  const out = new Map();
  for (const judged of blocks) {
    const bag = new Map();
    const keys = new Set(judged.cells.map((cell) => priorKey(cell)));
    for (const key of keys) {
      const donors = [];
      for (const other of blocks) {
        if (other.blockId === judged.blockId) continue;
        if (other.device !== judged.device) continue;
        if (other.layout !== judged.layout) continue;
        const mine = other.cells.filter((cell) => priorKey(cell) === key);
        if (mine.length === 0) continue;
        donors.push({
          blockId: other.blockId,
          pageId: other.pageId,
          clicking: mine.reduce((sum, cell) => sum + cell.clicking, 0),
          reached: mine.reduce((sum, cell) => sum + cell.reached, 0),
        });
      }
      const clicking = donors.reduce((sum, donor) => sum + donor.clicking, 0);
      const reached = donors.reduce((sum, donor) => sum + donor.reached, 0);
      const pages = new Set(donors.map((donor) => donor.pageId));
      const samePage = pages.size > 0 && [...pages].every((pageId) => pageId === judged.pageId);
      bag.set(key, {
        ctr: reached > 0 ? clicking / reached : 0,
        clicking,
        reached,
        eligible: clicking >= PRIOR_CLICK_FLOOR && reached > 0,
        priorScope: donors.length === 0 ? 'none' : samePage ? 'same_page_blocks' : 'other_pages',
        donorBlockIds: donors.map((donor) => donor.blockId),
        donorPages: pages.size,
      });
    }
    out.set(`${judged.blockId}|${judged.device}`, bag);
  }
  return out;
}

/**
 * Usual row-to-row reach drop, in share points, from other multi-row blocks.
 * @param {object[]} blocks
 * @param {object} judged
 * @returns {number | null} drop as a 0–1 share, or null when no donor rows exist
 */
export function usualRowDecay(blocks, judged) {
  /** @type {number[]} */
  const drops = [];
  for (const other of blocks) {
    if (other.blockId === judged.blockId || other.device !== judged.device) continue;
    if (other.layout === 'carousel' || other.layout === 'fitted_row') continue;
    const byRow = new Map();
    for (const cell of other.cells) {
      if (!byRow.has(cell.row)) byRow.set(cell.row, cell.rowReach);
    }
    const rows = [...byRow.keys()].sort((a, b) => a - b);
    for (let i = 1; i < rows.length; i++) {
      drops.push((byRow.get(rows[i - 1]) ?? 0) - (byRow.get(rows[i]) ?? 0));
    }
  }
  if (drops.length === 0) return null;
  const xs = [...drops].sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}
