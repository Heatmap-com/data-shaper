/**
 * One entry session, one cell, one device. A descendant click counts for
 * the cell. Image clicks are the attention numerator. Quick-add and the
 * quick-view submit stay separate counts.
 */

import { readFileSync } from 'node:fs';

const CLICK_PARTS = JSON.parse(readFileSync(new URL('./click-parts.json', import.meta.url), 'utf8'));

/**
 * @param {string} selector
 */
export function clickPart(selector) {
  const s = String(selector ?? '').toLowerCase();
  const hit = CLICK_PARTS.parts.find((entry) =>
    (entry.any ?? []).some((fragment) => s.includes(fragment)) ||
    (entry.all?.length > 0 && entry.all.every((fragment) => s.includes(fragment))));
  return hit?.part ?? CLICK_PARTS.fallback;
}

/**
 * @param {object[]} blocks classified blocks, each with templateStart
 * @param {Iterable<{idvisit: string, selector: string, date: string, week: string, device: string, orders: number, revenue: number}>} clicks re-iterable, walked once per cell
 * @param {Array<{idvisit: string, device: string, date: string, reachedPx: number}>} pageviews
 * @param {string} midpoint YYYY-MM-DD, early half is on or before this date
 */
export function rollup(blocks, clicks, pageviews, midpoint) {
  /** @type {object[]} */
  const windowCells = [];
  /** @type {object[]} */
  const weekRows = [];

  for (const block of blocks) {
    const start = block.templateStart || '0000-01-01';
    const cells = [...block.cells].sort((a, b) => b.selector.length - a.selector.length);
    const visits = reachVisits(block.device, start, pageviews);
    const entrySessions = visits.length;
    /** @type {Map<number, {share: number, sessions: number}>} */
    const reachByRow = new Map();
    for (const cell of block.cells) {
      if (reachByRow.has(cell.row)) continue;
      const sessions = visits.filter((visit) => visit.reachedPx > cell.y).length;
      reachByRow.set(cell.row, {
        sessions,
        share: entrySessions > 0 ? sessions / entrySessions : 0,
      });
    }

    for (const cell of block.cells) {
      /** @type {Map<string, {image: Set<string>, quickAdd: Set<string>, qv: Set<string>, orders: Set<string>, revenue: Map<string, number>, early: Set<string>, late: Set<string>}>} */
      const weeks = new Map();
      const blank = () => ({
        image: new Set(),
        quickAdd: new Set(),
        qv: new Set(),
        orders: new Set(),
        revenue: new Map(),
        early: new Set(),
        late: new Set(),
      });
      const ensure = (week) => {
        let bucket = weeks.get(week);
        if (!bucket) {
          bucket = blank();
          weeks.set(week, bucket);
        }
        return bucket;
      };

      for (const click of clicks) {
        if (click.device !== block.device) continue;
        if (click.date < start) continue;
        if (!matchesCell(click.selector, cell.selector)) continue;
        const owner = cells.find((candidate) => matchesCell(click.selector, candidate.selector));
        if (owner && owner.selector !== cell.selector) continue;
        const bucket = ensure(click.week || click.date);
        const part = clickPart(click.selector);
        if (part === 'quick_add') bucket.quickAdd.add(click.idvisit);
        else if (part === 'qv_submit') bucket.qv.add(click.idvisit);
        else bucket.image.add(click.idvisit);
        if (click.orders > 0) bucket.orders.add(click.idvisit);
        if (!bucket.revenue.has(click.idvisit)) bucket.revenue.set(click.idvisit, Number(click.revenue) || 0);
        if (click.date <= midpoint) bucket.early.add(click.idvisit);
        else bucket.late.add(click.idvisit);
      }

      const reach = reachByRow.get(cell.row) ?? { share: 0, sessions: 0 };
      const image = new Set();
      const quickAdd = new Set();
      const qv = new Set();
      const orders = new Set();
      const early = new Set();
      const late = new Set();
      let revenue = 0;
      const seenRevenue = new Set();
      for (const [week, bucket] of weeks) {
        for (const id of bucket.image) image.add(id);
        for (const id of bucket.quickAdd) quickAdd.add(id);
        for (const id of bucket.qv) qv.add(id);
        for (const id of bucket.orders) orders.add(id);
        for (const id of bucket.early) early.add(id);
        for (const id of bucket.late) late.add(id);
        for (const [id, value] of bucket.revenue) {
          if (seenRevenue.has(id)) continue;
          seenRevenue.add(id);
          revenue += value;
        }
        let weekRevenue = 0;
        for (const value of bucket.revenue.values()) weekRevenue += value;
        weekRows.push({
          ...cell,
          week,
          templateStart: start,
          clicking: bucket.image.size,
          quickAdd: bucket.quickAdd.size,
          qvSubmit: bucket.qv.size,
          orders: bucket.orders.size,
          revenue: weekRevenue,
          rowReach: reach.share,
          reached: reach.sessions,
          entrySessions,
        });
      }

      windowCells.push({
        ...cell,
        templateStart: start,
        clicking: image.size,
        quickAdd: quickAdd.size,
        qvSubmit: qv.size,
        orders: orders.size,
        revenue,
        earlyClicking: early.size,
        lateClicking: late.size,
        rowReach: reach.share,
        reached: reach.sessions,
        entrySessions,
      });
    }
  }

  return { windowCells, weekRows };
}

/**
 * @param {string} device
 * @param {string} start
 * @param {Array<{idvisit: string, device: string, date: string, reachedPx: number}>} pageviews
 */
function reachVisits(device, start, pageviews) {
  /** @type {Map<string, number>} */
  const maxPx = new Map();
  for (const view of pageviews) {
    if (view.device !== device || view.date < start) continue;
    const prev = maxPx.get(view.idvisit);
    if (prev == null || view.reachedPx > prev) maxPx.set(view.idvisit, view.reachedPx);
  }
  return [...maxPx.entries()].map(([idvisit, reachedPx]) => ({ idvisit, reachedPx }));
}

/**
 * @param {string} selector
 * @param {string} cellSelector
 */
function matchesCell(selector, cellSelector) {
  return selector === cellSelector || selector.startsWith(`${cellSelector} > `);
}
