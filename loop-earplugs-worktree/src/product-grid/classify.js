/**
 * Layout of a product_tile block from captured boxes.
 * Row breaks, layout names, and in-capture follow docs/PRODUCT-GRID.md §3.
 * Click coordinates are not an input.
 */

/**
 * @param {number[]} values
 */
export function median(values) {
  const xs = [...values].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * The cell is the slide. A section title that contains a row of slides is
 * the block, not a cell. A quick-add or a product-info node inside a slide
 * is a descendant, not a second cell.
 *
 * @param {Array<{selector: string, x: number, y: number, w: number, h: number}>} boxes
 */
export function cellBoxes(boxes) {
  const finite = boxes.filter(
    (b) =>
      b.selector &&
      Number.isFinite(b.x) &&
      Number.isFinite(b.y) &&
      Number.isFinite(b.w) &&
      Number.isFinite(b.h) &&
      b.w > 0 &&
      b.h > 0,
  );
  const containers = new Set(finite.filter((box) => containsTileRow(box, finite)).map((box) => box.selector));
  return finite.filter((box) => {
    if (containers.has(box.selector)) return false;
    const nestedInCell = finite.some(
      (other) =>
        !containers.has(other.selector) &&
        other.selector !== box.selector &&
        box.selector.startsWith(`${other.selector} > `),
    );
    return !nestedInCell;
  });
}

/**
 * True when the box's own child tiles form a row of similarly sized slides.
 * A slide that contains a button and a caption does not.
 *
 * @param {{selector: string, x: number, y: number, w: number, h: number}} box
 * @param {Array<{selector: string, x: number, y: number, w: number, h: number}>} boxes
 */
function containsTileRow(box, boxes) {
  const descendants = boxes.filter(
    (other) => other.selector !== box.selector && other.selector.startsWith(`${box.selector} > `),
  );
  const top = descendants.filter(
    (item) => !descendants.some((other) => item.selector !== other.selector && item.selector.startsWith(`${other.selector} > `)),
  );
  if (top.length < 2) return false;
  const width = median(top.map((item) => item.w));
  const height = median(top.map((item) => item.h));
  if (!(width > 0) || !(height > 0)) return false;
  const similar = top.filter(
    (item) => item.w >= width * 0.6 && item.w <= width * 1.4 && item.h >= height * 0.6 && item.h <= height * 1.4,
  );
  if (similar.length < 2) return false;
  const y = median(similar.map((item) => item.y));
  const threshold = Math.max(40, 0.35 * height);
  return similar.filter((item) => Math.abs(item.y - y) <= threshold).length >= 2;
}

/**
 * @param {string} selector
 */
function segments(selector) {
  return selector.split(' > ').map((part) => part.trim()).filter(Boolean);
}

/**
 * Longest selector prefix shared with at least one other cell.
 * Two carousels on one page stay two blocks.
 *
 * @param {Array<{selector: string}>} cells
 * @returns {string[]}
 */
function blockPrefixes(cells) {
  const segs = cells.map((cell) => segments(cell.selector));
  return segs.map((mine, i) => {
    let best = 0;
    for (let j = 0; j < segs.length; j++) {
      if (i === j) continue;
      let depth = 0;
      while (depth < mine.length && depth < segs[j].length && mine[depth] === segs[j][depth]) depth += 1;
      if (depth > best) best = depth;
    }
    const depth = Math.max(1, Math.min(best, mine.length));
    return mine.slice(0, depth).join(' > ');
  });
}

/**
 * @param {string} prefix
 */
export function blockLabel(prefix) {
  const parts = prefix.split(' > ');
  const hit = [...parts].reverse().find((part) => /carousel|grid|product|lifestyle|collection/i.test(part));
  return hit || parts[parts.length - 1] || prefix;
}

/**
 * @param {Array<{y: number, x: number, h: number}>} cells
 */
export function clusterRows(cells) {
  const threshold = Math.max(40, 0.35 * median(cells.map((cell) => cell.h)));
  const sorted = [...cells].sort((a, b) => a.y - b.y || a.x - b.x);
  /** @type {Array<Array<object>>} */
  const rows = [];
  for (const cell of sorted) {
    const row = rows[rows.length - 1];
    if (!row) {
      rows.push([cell]);
      continue;
    }
    const mid = median(row.map((item) => item.y));
    if (Math.abs(cell.y - mid) > threshold) rows.push([cell]);
    else row.push(cell);
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x);
  return rows;
}

/**
 * @param {{x: number, w: number}} cell
 * @param {number} captureW
 */
export function inCapture(cell, captureW) {
  const overlap = Math.max(0, Math.min(cell.x + cell.w, captureW) - Math.max(cell.x, 0));
  return overlap + 1e-9 >= cell.w / 2 ? 1 : 0;
}

/**
 * @param {string} layout
 * @param {number} y
 * @param {number} captureH
 */
export function depthBand(layout, y, captureH) {
  if (layout === 'carousel' || layout === 'fitted_row') return 'shared';
  if (!(captureH > 0)) return 'unknown';
  const band = Math.floor(y / captureH);
  if (band <= 0) return 'v0';
  if (band === 1) return 'v1';
  return 'v2plus';
}

/**
 * @param {Array<Array<{x: number, w: number}>>} rows
 * @param {number} captureW
 */
export function layoutOf(rows, captureW) {
  const rowCount = rows.length;
  const columns = Math.max(...rows.map((row) => row.length));
  const width = median(rows.flat().map((cell) => cell.w));
  const origin = rows[0][0].x;
  const originsAlign = rows.every((row) => Math.abs(row[0].x - origin) <= width / 2);
  const rightEdge = Math.max(...rows.map((row) => row[row.length - 1].x + row[row.length - 1].w));
  const overlaps = rows.some((row) => {
    for (let i = 1; i < row.length; i++) {
      const prev = row[i - 1];
      const overlap = prev.x + prev.w - row[i].x;
      if (overlap > Math.min(prev.w, row[i].w) * 0.5) return true;
    }
    return false;
  });
  if (overlaps) return 'irregular';
  if (columns === 1 && rowCount >= 2) return 'single_column';
  if (rowCount === 1 && columns >= 2 && rightEdge > captureW) return 'carousel';
  if (rowCount === 1 && columns >= 2 && rightEdge <= captureW) return 'fitted_row';
  if (columns >= 2 && rowCount >= 2 && originsAlign) return 'wrapped';
  return 'irregular';
}

/**
 * @param {Array<object>} boxes product_tile boxes for one device
 * @param {{device: string, width: number, height: number, pageId: string}} viewport
 */
export function classifyDevice(boxes, viewport) {
  const cells = cellBoxes(boxes);
  if (cells.length === 0) return [];
  const prefixes = blockPrefixes(cells);
  /** @type {Map<string, object[]>} */
  const groups = new Map();
  cells.forEach((cell, i) => {
    const prefix = prefixes[i];
    const group = groups.get(prefix) ?? [];
    group.push(cell);
    groups.set(prefix, group);
  });

  /** @type {object[]} */
  const blocks = [];
  for (const [prefix, group] of groups) {
    if (group.length < 2) continue;
    const rows = clusterRows(group);
    const layout = layoutOf(rows, viewport.width);
    const columns = Math.max(...rows.map((row) => row.length));
    /** @type {object[]} */
    const classified = [];
    let slot = 0;
    rows.forEach((row, rowIndex) => {
      row.forEach((cell, colIndex) => {
        slot += 1;
        classified.push({
          blockId: prefix,
          blockLabel: blockLabel(prefix),
          pageId: viewport.pageId,
          device: viewport.device,
          layout,
          slot: `C${slot}`,
          slotIndex: slot,
          row: rowIndex + 1,
          col: colIndex + 1,
          x: cell.x,
          y: cell.y,
          w: cell.w,
          h: cell.h,
          selector: cell.selector,
          name: String(cell.name ?? ''),
          inCapture: inCapture(cell, viewport.width),
          depthBand: depthBand(layout, cell.y, viewport.height),
          captureW: viewport.width,
          captureH: viewport.height,
          columns,
          rows: rows.length,
          nameAtCapture: true,
        });
      });
    });
    blocks.push({
      blockId: prefix,
      blockLabel: blockLabel(prefix),
      pageId: viewport.pageId,
      device: viewport.device,
      layout,
      captureW: viewport.width,
      captureH: viewport.height,
      columns,
      rows: rows.length,
      cells: classified,
    });
  }
  return blocks;
}

/**
 * @param {Array<object>} boxes
 * @param {Array<{device: string, width: number, height: number, pageId: string}>} viewports
 */
export function classifyPage(boxes, viewports) {
  const pageBoxes = boxes.filter((box) => !/cart-drawer|\bcart__|drawer__body|mini-cart/i.test(box.selector));
  /** @type {object[]} */
  const blocks = [];
  for (const viewport of viewports) {
    const mine = pageBoxes.filter((box) => box.device === viewport.device);
    blocks.push(...classifyDevice(mine, viewport));
  }
  return alignBlockIds(blocks);
}

/**
 * Desktop and mobile copies of one carousel share a prefix when the DOM
 * matches. When the paths differ, pair the blocks that share the most names.
 *
 * @param {object[]} blocks
 */
function alignBlockIds(blocks) {
  const byId = new Map();
  for (const block of blocks) {
    const list = byId.get(block.blockId) ?? [];
    list.push(block);
    byId.set(block.blockId, list);
  }
  for (const block of blocks) {
    const siblings = byId.get(block.blockId) ?? [];
    if (siblings.some((other) => other.device !== block.device)) continue;
    const names = new Set(block.cells.map((cell) => normName(cell.name)).filter(Boolean));
    let best = null;
    let bestScore = 0;
    for (const other of blocks) {
      if (other.device === block.device) continue;
      const shared = other.cells.filter((cell) => names.has(normName(cell.name))).length;
      if (shared > bestScore) {
        best = other;
        bestScore = shared;
      }
    }
    if (!best || bestScore < 2) continue;
    const canonical = best.blockId.length <= block.blockId.length ? best.blockId : block.blockId;
    for (const target of [block, best]) {
      target.blockId = canonical;
      target.blockLabel = blockLabel(canonical);
      for (const cell of target.cells) {
        cell.blockId = canonical;
        cell.blockLabel = target.blockLabel;
      }
    }
  }
  return blocks;
}

/**
 * @param {string} name
 */
export function normName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}
