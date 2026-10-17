/**
 * Grid flags the stored facts can support.
 * R5, R6, R9, and R10 stay off: they need per-cell add-to-cart, a product
 * family, many collection pages, or inventory. R4 is stored as a watch.
 * Lift rules run only when the leave-one-out prior for that column is eligible.
 */

import { normName } from './classify.js';
import { priorKey, usualRowDecay } from './baseline.js';
import { liftIntervalExcludesOne, median, poissonAtMost, spearman } from './stats.js';
import { narrativeOf, pct, priorPhrase } from './narrative.js';

export { liftIntervalExcludesOne, poissonAtMost, wilsonInterval } from './stats.js';

const CLICK_FLOOR = 20;
const SHARE_RATIO = 2;
const LIFT_BAR = 1.5;

/**
 * @typedef {object} GridRule
 * @property {string} id
 * @property {(input: {cells: object[], priors: Map<string, Map<string, object>>, blocks: object[], label: string}) => object[]} evaluate
 * @property {string[]} [layouts] the layouts the rule reads; every layout when absent
 */

/**
 * The rules a block runs, in the order its flags are listed. A rule reads
 * only the layouts it names, because row and slot order mean something
 * only where the grid has them.
 * @type {GridRule[]}
 */
const RULES = [
  { id: 'dead-zones', evaluate: ({ cells, priors, label }) => deadZones(cells, priors, label) },
  { id: 'cross-device', evaluate: ({ cells, priors, label }) => crossDevice(cells, priors, label) },
  { id: 'slot-overperformers', evaluate: ({ cells, priors, label }) => slotOverperformers(cells, priors, label) },
  { id: 'prime-watches', evaluate: ({ cells, label }) => primeWatches(cells, label) },
  { id: 'reach-cliffs', evaluate: ({ cells, blocks, label }) => reachCliffs(cells, blocks, label) },
  { id: 'within-row', layouts: ['wrapped', 'fitted_row'], evaluate: ({ cells, priors, label }) => withinRow(cells, priors, label) },
  { id: 'sort-order', layouts: ['wrapped', 'single_column'], evaluate: ({ cells, priors, label }) => sortOrder(cells, priors, label) },
];

/**
 * @param {object[]} cells
 * @param {Map<string, Map<string, object>>} priors
 * @param {object[]} [blocks] classified blocks, for the usual-decay prior
 */
export function evaluateGrid(cells, priors, blocks = []) {
  /** @type {object[]} */
  const flags = [];
  const byBlock = groupBy(cells.filter((cell) => cell.layout !== 'irregular'), (cell) => cell.blockId);
  for (const [blockId, blockCells] of byBlock) {
    flags.push(...flagsForBlock(blockId, blockCells, priors, blocks));
  }
  const narrative = narrativeOf(flags);
  return { flags, narrative };
}

/**
 * @param {string} blockId
 * @param {object[]} cells
 * @param {Map<string, Map<string, object>>} priors
 * @param {object[]} blocks
 */
function flagsForBlock(blockId, cells, priors, blocks) {
  /** @type {object[]} */
  const flags = [];
  const layout = cells[0]?.layout;
  const label = cells[0]?.blockLabel || 'product grid';
  for (const { evaluate, layouts } of RULES) {
    if (!layouts || layouts.includes(layout)) flags.push(...evaluate({ cells, priors, blocks, label }));
  }
  return flags.map((flag) => ({ ...flag, blockId }));
}

/**
 * @param {object} cell
 * @param {Map<string, Map<string, object>>} priors
 */
function priorFor(cell, priors) {
  const bag = priors.get(`${cell.blockId}|${cell.device}`);
  return bag?.get(priorKey(cell)) ?? null;
}

/**
 * @param {object} cell
 * @param {Map<string, Map<string, object>>} priors
 */
function liftOf(cell, priors) {
  const prior = priorFor(cell, priors);
  if (!prior?.eligible || !(prior.ctr > 0) || !(cell.reached > 0)) return null;
  return {
    lift: cell.clicking / (cell.reached * prior.ctr),
    prior,
    excludesOne: liftIntervalExcludesOne(cell.clicking, cell.reached, prior.ctr),
  };
}

/**
 * @param {object[]} cells
 * @param {Map<string, Map<string, object>>} priors
 * @param {string} label
 */
function deadZones(cells, priors, label) {
  /** @type {object[]} */
  const flags = [];
  const layout = cells[0].layout;
  for (const [device, deviceCells] of groupBy(cells, (cell) => cell.device)) {
    if (layout === 'carousel') {
      flags.push(...carouselCollapse(deviceCells, priors, label, device));
    } else if (layout === 'fitted_row') {
      flags.push(...shareCollapse(deviceCells, label, device, 'the row'));
    } else {
      flags.push(...rowCollapse(deviceCells, label, device));
    }
  }
  return flags;
}

/**
 * @param {object[]} cells
 * @param {Map<string, Map<string, object>>} priors
 * @param {string} label
 * @param {string} device
 */
function carouselCollapse(cells, priors, label, device) {
  const inside = cells.filter((cell) => cell.inCapture === 1).sort((a, b) => a.slotIndex - b.slotIndex);
  const lifts = inside.map((cell) => liftOf(cell, priors)).filter(Boolean);
  if (lifts.length === inside.length && inside.length >= 2) {
    const run = adjacentRun(inside, (cell) => {
      const lift = liftOf(cell, priors);
      return lift != null && lift.lift < 0.5 && cell.clicking >= CLICK_FLOOR;
    });
    if (run.length >= 2) {
      return [collapseFlag(run, label, device, 'attention')];
    }
  }
  return shareCollapse(inside, label, device, 'the captured first screen');
}

/**
 * @param {object[]} cells
 * @param {string} label
 * @param {string} device
 * @param {string} where
 */
function shareCollapse(cells, label, device, where) {
  if (cells.length < 3) return [];
  const sorted = [...cells].sort((a, b) => a.slotIndex - b.slotIndex);
  const shares = clickShares(sorted);
  const run = adjacentRun(sorted, (cell) => {
    const others = sorted.filter((item) => item !== cell);
    const mid = median(others.map((item) => shares.get(item) ?? 0));
    return mid > 0 && (shares.get(cell) ?? 0) <= mid * 0.5;
  });
  if (run.length < 2) return [];
  const clicking = run.reduce((sum, cell) => sum + cell.clicking, 0);
  if (clicking < CLICK_FLOOR) {
    return [insufficient(`R1`, label, device, run, `${slotList(run)} inside ${where} is under the 20-session gate`)];
  }
  return [collapseFlag(run, label, device, 'attention', where)];
}

/**
 * @param {object[]} cells
 * @param {string} label
 * @param {string} device
 */
function rowCollapse(cells, label, device) {
  /** @type {object[]} */
  const flags = [];
  const rows = [...groupBy(cells, (cell) => cell.row).entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
  for (let i = 1; i < rows.length; i++) {
    const earlier = rows[i - 1][1];
    const later = rows[i][1];
    const earlierClicks = sum(earlier, 'clicking');
    const laterClicks = sum(later, 'clicking');
    const earlierReached = earlier[0].reached || 0;
    const laterReached = later[0].reached || 0;
    if (earlierClicks < CLICK_FLOOR || laterClicks < CLICK_FLOOR) continue;
    if (!(earlierReached > 0) || !(laterReached > 0)) continue;
    const earlierCtr = earlierClicks / earlierReached;
    const laterCtr = laterClicks / laterReached;
    if (!(earlierCtr > 0) || laterCtr > earlierCtr * 0.5) continue;
    const reachDrop = (earlier[0].rowReach ?? 0) - (later[0].rowReach ?? 0);
    const cause = reachDrop >= 0.15 ? 'reach' : 'attention';
    flags.push({
      rule: 'R1',
      layout: cells[0].layout,
      slot: '',
      slots: later.map((cell) => cell.slot),
      device,
      action: 'diagnose',
      rung: 'clicks',
      stable: stableSide(earlier, later),
      provisional: false,
      nameAtCapture: true,
      impact: impactOf({ sessions: laterClicks, gap: 0.5, mobile: device === 'mobile', prime: false }),
      effort: 2,
      inNarrative: true,
      narrative:
        `On the ${label} ${cells[0].layout.replace('_', ' ')}, row ${later[0].row} draws ${laterClicks} clicking sessions against ${earlierClicks} on the row above. ` +
        (cause === 'reach'
          ? 'Reach falls with the clicks. Hypothesis: people are not arriving at that row.'
          : 'Reach holds while the click rate falls. Hypothesis: people arrive and pass the row.') +
        ' Names are the products in those slots at capture.',
    });
  }
  return flags.map(finish);
}

/**
 * @param {object[]} run
 * @param {string} label
 * @param {string} device
 * @param {string} cause
 * @param {string} [where]
 */
function collapseFlag(run, label, device, cause, where = 'the captured first screen') {
  const clicking = sum(run, 'clicking');
  return finish({
    rule: 'R1',
    layout: run[0].layout,
    slot: '',
    slots: run.map((cell) => cell.slot),
    device,
    action: 'diagnose',
    rung: 'clicks',
    stable: halvesAgree(run, (cell) => cell.earlyClicking, (cell) => cell.lateClicking),
    provisional: false,
    nameAtCapture: true,
    impact: impactOf({ sessions: clicking, gap: 0.5, mobile: device === 'mobile', prime: false }),
    effort: 2,
    inNarrative: true,
    narrative:
      `On the ${label} ${run[0].layout.replaceAll('_', ' ')}, ${slotList(run)} sit inside ${where} and their click share collapses together ` +
      `(${clicking} clicking sessions on ${device}). Hypothesis: the collapse is the layout, so a product test in those slots waits. ` +
      'Names are the products in those slots at capture.',
  });
}

/**
 * @param {object[]} cells
 * @param {Map<string, Map<string, object>>} priors
 * @param {string} label
 */
function crossDevice(cells, priors, label) {
  const desktop = cells.filter((cell) => cell.device === 'desktop');
  const mobile = cells.filter((cell) => cell.device === 'mobile');
  const pairs = pairByName(desktop, mobile);
  if (pairs.length === 0) return [];
  const useLift = pairs.every((pair) => liftOf(pair.desktop, priors) && liftOf(pair.mobile, priors));
  const scored = pairs.map((pair) => {
    const dShare = share(pair.desktop, desktop);
    const mShare = share(pair.mobile, mobile);
    const dLift = liftOf(pair.desktop, priors);
    const mLift = liftOf(pair.mobile, priors);
    const ratio = useLift && dLift && mLift && mLift.lift > 0 ? dLift.lift / mLift.lift : mShare > 0 ? dShare / mShare : dShare > 0 ? Infinity : 1;
    return { ...pair, dShare, mShare, ratio, dLift, mLift };
  });
  /** @type {object[]} */
  const flags = [];
  const consumed = new Set();
  const layout = cells[0].layout;
  if (layout === 'carousel') {
    for (const direction of ['desktop-weak', 'mobile-weak']) {
      const run = exposureRun(scored, direction);
      if (run.length < 2) continue;
      const dClicks = sum(run.map((item) => item.desktop), 'clicking');
      const mClicks = sum(run.map((item) => item.mobile), 'clicking');
      const dShare = dClicks / Math.max(1, sum(desktop, 'clicking'));
      const mShare = mClicks / Math.max(1, sum(mobile, 'clicking'));
      const ratio = mShare > 0 ? dShare / mShare : Infinity;
      if (!(ratio >= SHARE_RATIO || ratio <= 1 / SHARE_RATIO)) continue;
      for (const item of run) consumed.add(item);
      if (dClicks < CLICK_FLOOR || mClicks < CLICK_FLOOR) {
        flags.push(insufficient('R2', label, 'both', run.map((item) => item.desktop), `${slotList(run.map((item) => item.desktop))} are under the 20-session gate on one device`));
        continue;
      }
      const stable = runHalves(run);
      flags.push(finish({
        rule: 'R2',
        layout,
        slot: '',
        slots: run.map((item) => item.desktop.slot),
        device: 'both',
        action: stable ? 'diagnose' : 'watch',
        rung: 'clicks',
        stable,
        provisional: true,
        exposure: true,
        nameAtCapture: true,
        priorScope: useLift ? run[0].dLift.prior.priorScope : null,
        impact: impactOf({
          sessions: Math.max(dClicks, mClicks),
          gap: Math.abs(dShare - mShare),
          mobile: true,
          prime: false,
        }),
        effort: 2,
        inNarrative: true,
        narrative:
          `On the ${label} carousel, ${slotList(run.map((item) => item.desktop))} take ${pct(dShare)} of desktop cell clicks ` +
          `and ${pct(mShare)} of mobile cell clicks (${dClicks} and ${mClicks} clicking sessions). ` +
          'Those slots are off-screen in the captured layout on the quieter device. ' +
          'Hypothesis: the gap is swipe exposure. Confirm the carousel before treating a product in that run as weak. ' +
          'The desktop and mobile cells are joined on the captured name, and the name is the product in the slot at capture.',
      }));
    }
  }
  for (const item of scored) {
    if (consumed.has(item)) continue;
    const clearsRatio = item.ratio >= SHARE_RATIO || item.ratio <= 1 / SHARE_RATIO;
    if (!clearsRatio) continue;
    const dClicks = item.desktop.clicking;
    const mClicks = item.mobile.clicking;
    if (dClicks < CLICK_FLOOR || mClicks < CLICK_FLOOR) {
      flags.push(insufficient('R2', label, 'both', [item.desktop], `${item.desktop.name || item.desktop.slot} is under the 20-session gate on one device`));
      continue;
    }
    const stable = pairHalves(item);
    const family = familyNote(item, scored);
    flags.push(finish({
      rule: 'R2',
      layout,
      slot: item.desktop.slot,
      slots: [item.desktop.slot],
      device: 'both',
      action: stable ? 'test' : 'watch',
      rung: 'clicks',
      stable,
      provisional: true,
      held: true,
      nameAtCapture: true,
      priorScope: useLift ? item.dLift?.prior.priorScope ?? null : null,
      liftForm: useLift,
      impact: impactOf({
        sessions: Math.max(dClicks, mClicks),
        gap: Math.abs(item.dShare - item.mShare),
        mobile: true,
        prime: false,
      }),
      effort: 5,
      inNarrative: true,
      narrative:
        `${item.desktop.name || item.desktop.slot} on the ${label} ${layout.replaceAll('_', ' ')} takes ${pct(item.dShare)} of desktop cell clicks ` +
        `and ${pct(item.mShare)} of mobile cell clicks (${dClicks} and ${mClicks} clicking sessions)` +
        (useLift ? `, and the lift ratio is ${item.ratio.toFixed(2)}` : '') +
        '. Hypothesis: one viewport is showing this slot differently. ' +
        'The join is the captured name. Identity is unconfirmed, so a move waits on a product id.' +
        (family ? ` ${family}` : ''),
    }));
  }
  return flags;
}

/**
 * @param {object[]} scored
 * @param {'desktop-weak' | 'mobile-weak'} direction
 */
function exposureRun(scored, direction) {
  const sorted = [...scored].sort((a, b) => a.desktop.slotIndex - b.desktop.slotIndex);
  /** @type {object[][]} */
  const runs = [];
  /** @type {object[]} */
  let current = [];
  for (const item of sorted) {
    const weakDesktop = item.ratio < 1 && item.desktop.inCapture === 0;
    const weakMobile = item.ratio > 1 && item.mobile.inCapture === 0;
    const matches = direction === 'desktop-weak' ? weakDesktop : weakMobile;
    const adjacent = current.length === 0 || item.desktop.slotIndex === current[current.length - 1].desktop.slotIndex + 1;
    if (matches && adjacent) current.push(item);
    else {
      if (current.length) runs.push(current);
      current = matches ? [item] : [];
    }
  }
  if (current.length) runs.push(current);
  return runs.sort((a, b) => b.length - a.length)[0] ?? [];
}

/**
 * @param {object[]} cells
 * @param {Map<string, Map<string, object>>} priors
 * @param {string} label
 */
function slotOverperformers(cells, priors, label) {
  /** @type {object[]} */
  const flags = [];
  for (const cell of cells) {
    if (cell.clicking < CLICK_FLOOR) continue;
    if (isPrime(cell)) continue;
    const lift = liftOf(cell, priors);
    if (!lift || lift.lift < LIFT_BAR || !lift.excludesOne) continue;
    const artifact = columnIsHot(cell, cells);
    const stable = halvesAgree([cell], (item) => item.earlyClicking, (item) => item.lateClicking);
    const samePage = lift.prior.priorScope === 'same_page_blocks';
    flags.push(finish({
      rule: 'R3',
      layout: cell.layout,
      slot: cell.slot,
      slots: [cell.slot],
      device: cell.device,
      action: artifact ? 'diagnose' : stable ? 'test' : 'watch',
      rung: 'clicks',
      stable,
      provisional: true,
      held: !artifact,
      nameAtCapture: true,
      priorScope: lift.prior.priorScope,
      impact: impactOf({
        sessions: cell.clicking,
        gap: lift.lift - 1,
        mobile: cell.device === 'mobile',
        prime: false,
      }),
      effort: artifact ? 2 : 5,
      inNarrative: true,
      narrative: artifact
        ? `${cell.name || cell.slot} on the ${label} grid lifts ${lift.lift.toFixed(2)} on ${cell.device}, and the same column is hot on the other block. Hypothesis: the pull belongs to the slot. The prior is ${priorPhrase(lift.prior)}. The name is the product in the slot at capture.`
        : `${cell.name || cell.slot} (${cell.slot}) on the ${label} grid lifts ${lift.lift.toFixed(2)} on ${cell.device}, from ${cell.clicking} clicking sessions, past the column prior. Hypothesis: the slot is pulling more than its position. ${samePage ? 'The prior is the other block on this page, so a cross-page slot check is still open.' : 'The prior leaves this block out.'} Identity is unconfirmed, and the name is the product in the slot at capture.`,
    }));
  }
  return flags;
}

/**
 * A donor column is a slot habit when its click share is at least 1.3×
 * that block's median column share.
 * @param {object} cell
 * @param {object[]} cells
 */
function columnIsHot(cell, cells) {
  const donors = cells.filter(
    (other) =>
      other.blockId !== cell.blockId &&
      other.device === cell.device &&
      other.layout === cell.layout &&
      other.col === cell.col &&
      other.inCapture === cell.inCapture,
  );
  return donors.some((donor) => {
    const siblings = cells.filter((other) => other.blockId === donor.blockId && other.device === donor.device);
    const shares = clickShares(siblings);
    const mid = median([...shares.values()]);
    return mid > 0 && (shares.get(donor) ?? 0) >= mid * 1.3;
  });
}

/**
 * @param {object[]} cells
 * @param {string} label
 */
function primeWatches(cells, label) {
  /** @type {object[]} */
  const flags = [];
  for (const [device, deviceCells] of groupBy(cells, (cell) => cell.device)) {
    const clicking = sum(deviceCells, 'clicking');
    const orders = sum(deviceCells, 'orders');
    if (clicking === 0) continue;
    const rate = orders / clicking;
    const shares = clickShares(deviceCells);
    const midShare = median([...shares.values()]);
    for (const cell of deviceCells) {
      if (!isPrime(cell) || cell.clicking < CLICK_FLOOR) continue;
      if ((shares.get(cell) ?? 0) < midShare) continue;
      const expected = rate * cell.clicking;
      if (expected >= 3 && poissonAtMost(expected, cell.orders) < 0.05) {
        flags.push(finish({
          rule: 'R4',
          layout: cell.layout,
          slot: cell.slot,
          slots: [cell.slot],
          device,
          action: 'watch',
          rung: 'orders',
          stable: false,
          provisional: true,
          nameAtCapture: true,
          impact: 2,
          effort: 5,
          inNarrative: false,
          narrative: `${cell.name || cell.slot} is a prime slot on ${device} with orders below the pooled rate. Per-cell add-to-cart is unavailable, so this stays a watch. Confirm stock before acting. The name is the product at capture.`,
        }));
        continue;
      }
      if (expected < 3) {
        flags.push(finish({
          rule: 'R4',
          layout: cell.layout,
          slot: cell.slot,
          slots: [cell.slot],
          device,
          action: 'watch',
          rung: 'orders',
          stable: false,
          provisional: true,
          nameAtCapture: true,
          impact: 1,
          effort: 5,
          inNarrative: false,
          narrative:
            `${cell.name || cell.slot} is a prime slot on ${label}, ${device}, with ${cell.orders} orders in ${cell.clicking} clicking sessions. ` +
            `The block order rate expects about ${expected.toFixed(1)} orders, under the gate of 3. This is a watch. Confirm stock before acting. ` +
            'The name is the product in the slot at capture.',
        }));
      }
    }
  }
  return flags;
}

/**
 * @param {object[]} cells
 * @param {object[]} blocks
 * @param {string} label
 */
function reachCliffs(cells, blocks, label) {
  const layout = cells[0].layout;
  if (layout === 'carousel' || layout === 'fitted_row') return [];
  /** @type {object[]} */
  const flags = [];
  for (const [device, deviceCells] of groupBy(cells, (cell) => cell.device)) {
    const byRow = [...groupBy(deviceCells, (cell) => cell.row).entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
    const usual = usualRowDecay(blocks, { blockId: cells[0].blockId, device });
    for (let i = 1; i < byRow.length; i++) {
      const prev = byRow[i - 1][1][0];
      const next = byRow[i][1][0];
      const drop = (prev.rowReach ?? 0) - (next.rowReach ?? 0);
      const fifteen = drop >= 0.15;
      const twice = usual != null && usual > 0 && drop >= usual * 2 && drop > 0;
      if (!fifteen && !twice) continue;
      flags.push(finish({
        rule: 'R7',
        layout,
        slot: '',
        slots: byRow[i][1].map((cell) => cell.slot),
        device,
        action: 'diagnose',
        rung: 'clicks',
        stable: true,
        provisional: !fifteen && twice,
        nameAtCapture: true,
        impact: impactOf({ sessions: next.entrySessions || next.reached || 0, gap: drop, mobile: device === 'mobile', prime: false }),
        effort: 2,
        inNarrative: true,
        narrative:
          `On the ${label} grid, reach falls ${Math.round(drop * 100)} points from row ${prev.row} to row ${next.row} on ${device}. ` +
          (fifteen
            ? 'Hypothesis: a fold or a visual end is stopping the scroll.'
            : 'The drop is at least twice the usual row decay on the other blocks. Hypothesis: this break is sharper than the site’s other grids.') +
          ' Names are the products at capture.',
      }));
    }
  }
  return flags;
}

/**
 * @param {object[]} cells
 * @param {Map<string, Map<string, object>>} priors
 * @param {string} label
 */
function withinRow(cells, priors, label) {
  /** @type {object[]} */
  const flags = [];
  const layout = cells[0].layout;
  for (const [device, deviceCells] of groupBy(cells, (cell) => cell.device)) {
    const byRow = [...groupBy(deviceCells, (cell) => cell.row).values()];
    const priorReady = deviceCells.every((cell) => priorFor(cell, priors)?.eligible);
    if (priorReady && byRow.length >= 2 && layout === 'wrapped') {
      flags.push(...columnPriorFlags(deviceCells, priors, label, device));
      continue;
    }
    for (const row of byRow) {
      const eligible = row.filter((cell) => cell.clicking >= CLICK_FLOOR);
      if (eligible.length < 2) continue;
      const shares = clickShares(row);
      const mid = median(eligible.map((cell) => shares.get(cell) ?? 0));
      for (const cell of eligible) {
        const cellShare = shares.get(cell) ?? 0;
        if (!(mid > 0) || (cellShare < mid * 1.5 && cellShare > mid / 1.5)) continue;
        flags.push(finish({
          rule: 'R8',
          layout,
          slot: cell.slot,
          slots: [cell.slot],
          device,
          action: 'diagnose',
          rung: 'clicks',
          stable: halvesAgree([cell], (item) => item.earlyClicking, (item) => item.lateClicking),
          provisional: true,
          nameAtCapture: true,
          impact: impactOf({ sessions: cell.clicking, gap: Math.abs(cellShare - mid), mobile: device === 'mobile', prime: cell.row === 1 }),
          effort: 2,
          inNarrative: true,
          narrative:
            `${cell.name || cell.slot} takes ${pct(cellShare)} of clicks in its row on ${device}, against a row median of ${pct(mid)}. ` +
            'No column prior was subtracted. Hypothesis: the contrast is inside the row, where reach is shared. The name is the product at capture.',
        }));
      }
    }
  }
  return flags;
}

/**
 * @param {object[]} cells
 * @param {Map<string, Map<string, object>>} priors
 * @param {string} label
 * @param {string} device
 */
function columnPriorFlags(cells, priors, label, device) {
  /** @type {object[]} */
  const flags = [];
  const byCol = [...groupBy(cells, (cell) => cell.col).values()];
  for (const colCells of byCol) {
    if (colCells.length < 2) continue;
    const ratios = colCells.map((cell) => {
      const prior = priorFor(cell, priors);
      if (!prior?.eligible || !(prior.ctr > 0) || !(cell.reached > 0)) return null;
      return cell.clicking / cell.reached / prior.ctr;
    });
    if (ratios.some((ratio) => ratio == null)) continue;
    const high = ratios.every((ratio) => ratio >= 1.5);
    const low = ratios.every((ratio) => ratio <= 1 / 1.5);
    if (!high && !low) continue;
    if (colCells.some((cell) => cell.clicking < CLICK_FLOOR)) continue;
    flags.push(finish({
      rule: 'R8',
      layout: cells[0].layout,
      slot: '',
      slots: colCells.map((cell) => cell.slot),
      device,
      action: 'diagnose',
      rung: 'clicks',
      stable: halvesAgree(colCells, (cell) => cell.earlyClicking, (cell) => cell.lateClicking),
      provisional: priors.get(`${cells[0].blockId}|${device}`)?.values().next().value?.priorScope === 'same_page_blocks',
      nameAtCapture: true,
      priorScope: priorFor(colCells[0], priors)?.priorScope ?? null,
      impact: impactOf({ sessions: sum(colCells, 'clicking'), gap: 0.5, mobile: device === 'mobile', prime: false }),
      effort: 2,
      inNarrative: true,
      narrative:
        `Column ${colCells[0].col} on the ${label} grid stays ${high ? 'above' : 'below'} the column prior across ${colCells.length} rows on ${device}. ` +
        `${priorPhrase(priorFor(colCells[0], priors))}. Hypothesis: the column, rather than one product, is pulling. Names are the products at capture.`,
    }));
  }
  return flags;
}

/**
 * @param {object[]} cells
 * @param {Map<string, Map<string, object>>} priors
 * @param {string} label
 */
function sortOrder(cells, priors, label) {
  /** @type {object[]} */
  const flags = [];
  for (const [device, deviceCells] of groupBy(cells, (cell) => cell.device)) {
    const eligible = deviceCells.filter((cell) => cell.clicking >= CLICK_FLOOR);
    if (eligible.length < 6) continue;
    const lifts = eligible.map((cell) => liftOf(cell, priors));
    const useLift = lifts.every(Boolean);
    const score = useLift ? lifts.map((item) => item.lift) : eligible.map((cell) => cell.clicking);
    const rho = spearman(eligible.map((cell) => cell.slotIndex), score.map((value, i) => -value));
    // Negative of the score so the highest pull ranks like the earliest slot.
    if (!(rho < 0.3)) continue;
    flags.push(finish({
      rule: 'R11',
      layout: cells[0].layout,
      slot: '',
      slots: eligible.map((cell) => cell.slot),
      device,
      action: 'test',
      rung: 'clicks',
      stable: true,
      provisional: !useLift || lifts[0].prior.priorScope === 'same_page_blocks',
      nameAtCapture: true,
      priorScope: useLift ? lifts[0].prior.priorScope : null,
      impact: 3,
      effort: 5,
      inNarrative: true,
      narrative:
        `On the ${label} grid, slot order and ${useLift ? 'lift' : 'click'} order on ${device} disagree (rank correlation ${rho.toFixed(2)}) across ${eligible.length} slots that clear 20 clicking sessions. ` +
        (useLift ? '' : 'No column prior was subtracted. ') +
        'Hypothesis: a sort that follows pull is worth a test. Names are the products at capture.',
    }));
  }
  return flags;
}

/**
 * @param {object} cell
 */
function isPrime(cell) {
  if (cell.layout === 'carousel') return cell.inCapture === 1;
  return cell.row === 1;
}

/**
 * @param {object[]} desktop
 * @param {object[]} mobile
 */
function pairByName(desktop, mobile) {
  /** @type {object[]} */
  const pairs = [];
  const used = new Set();
  for (const cell of desktop) {
    const name = normName(cell.name);
    if (!name) continue;
    const matches = mobile.filter((other) => normName(other.name) === name && !used.has(other));
    if (matches.length !== 1) continue;
    used.add(matches[0]);
    pairs.push({ desktop: cell, mobile: matches[0] });
  }
  return pairs;
}

/**
 * @param {object} item
 * @param {object[]} scored
 */
function familyNote(item, scored) {
  const stem = stemOf(item.desktop.name);
  if (!stem) return '';
  const kin = scored.filter(
    (other) =>
      other !== item &&
      stemOf(other.desktop.name) === stem &&
      ((other.ratio >= 1 && item.ratio >= 1) || (other.ratio <= 1 && item.ratio <= 1)),
  );
  if (kin.length === 0) return '';
  return `${item.desktop.name} and ${kin.map((other) => other.desktop.name).join(', ')} move the same way from slots that are not adjacent. That is a family hypothesis, and it is not a product-family id.`;
}

/**
 * @param {string} name
 */
function stemOf(name) {
  const tokens = normName(name).split(' ').filter((token) => token.length >= 4 && !/^\d+$/.test(token));
  return tokens[0] ?? '';
}

/**
 * @param {object[]} group
 * @param {(cell: object) => boolean} pred
 */
function adjacentRun(group, pred) {
  const sorted = [...group].sort((a, b) => a.slotIndex - b.slotIndex);
  /** @type {object[]} */
  let best = [];
  /** @type {object[]} */
  let current = [];
  for (const cell of sorted) {
    const ok = pred(cell);
    const adjacent = current.length === 0 || cell.slotIndex === current[current.length - 1].slotIndex + 1;
    if (ok && adjacent) current.push(cell);
    else {
      if (current.length > best.length) best = current;
      current = ok ? [cell] : [];
    }
  }
  if (current.length > best.length) best = current;
  return best;
}

/**
 * @param {object[]} cells
 */
function clickShares(cells) {
  const total = sum(cells, 'clicking');
  return new Map(cells.map((cell) => [cell, total > 0 ? cell.clicking / total : 0]));
}

/**
 * @param {object} cell
 * @param {object[]} block
 */
function share(cell, block) {
  const total = sum(block, 'clicking');
  return total > 0 ? cell.clicking / total : 0;
}

/**
 * @param {object[]} rows
 * @param {string} key
 */
function sum(rows, key) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

/**
 * @param {object[]} cells
 */
function slotList(cells) {
  return cells.map((cell) => cell.slot).join(', ');
}

/**
 * @param {object[]} cells
 * @param {(cell: object) => number} early
 * @param {(cell: object) => number} late
 */
function halvesAgree(cells, early, late) {
  const e = cells.reduce((total, cell) => total + (Number(early(cell)) || 0), 0);
  const l = cells.reduce((total, cell) => total + (Number(late(cell)) || 0), 0);
  if (e === 0 || l === 0) return false;
  return true;
}

/**
 * @param {object} item
 */
function pairHalves(item) {
  const earlyD = item.desktop.earlyClicking || 0;
  const earlyM = item.mobile.earlyClicking || 0;
  const lateD = item.desktop.lateClicking || 0;
  const lateM = item.mobile.lateClicking || 0;
  if (earlyD === 0 || earlyM === 0 || lateD === 0 || lateM === 0) return false;
  const early = earlyD / earlyM;
  const late = lateD / lateM;
  const windowRatio = item.ratio;
  const side = (ratio) => (ratio >= 1 ? 1 : -1);
  return side(early) === side(windowRatio) && side(late) === side(windowRatio);
}

/**
 * @param {object[]} run
 */
function runHalves(run) {
  const earlyD = run.reduce((total, item) => total + (item.desktop.earlyClicking || 0), 0);
  const earlyM = run.reduce((total, item) => total + (item.mobile.earlyClicking || 0), 0);
  const lateD = run.reduce((total, item) => total + (item.desktop.lateClicking || 0), 0);
  const lateM = run.reduce((total, item) => total + (item.mobile.lateClicking || 0), 0);
  if (earlyM === 0 || lateM === 0 || earlyD === 0 || lateD === 0) return false;
  const early = earlyD / earlyM;
  const late = lateD / lateM;
  const windowD = run.reduce((total, item) => total + item.desktop.clicking, 0);
  const windowM = run.reduce((total, item) => total + item.mobile.clicking, 0);
  const side = (ratio) => (ratio >= 1 ? 1 : -1);
  const windowRatio = windowM > 0 ? windowD / windowM : 1;
  return side(early) === side(windowRatio) && side(late) === side(windowRatio);
}

/**
 * @param {object[]} earlier
 * @param {object[]} later
 */
function stableSide(earlier, later) {
  const earlyE = sum(earlier, 'earlyClicking');
  const earlyL = sum(later, 'earlyClicking');
  const lateE = sum(earlier, 'lateClicking');
  const lateL = sum(later, 'lateClicking');
  if (earlyE === 0 || earlyL === 0 || lateE === 0 || lateL === 0) return false;
  return earlyL / earlyE < 1 && lateL / lateE < 1;
}

/**
 * @param {string} rule
 * @param {string} label
 * @param {string} device
 * @param {object[]} cells
 * @param {string} detail
 */
function insufficient(rule, label, device, cells, detail) {
  return finish({
    rule,
    layout: cells[0]?.layout ?? '',
    slot: cells.length === 1 ? cells[0].slot : '',
    slots: cells.map((cell) => cell.slot),
    device,
    action: 'watch',
    rung: 'clicks',
    stable: false,
    provisional: true,
    insufficient: true,
    nameAtCapture: true,
    impact: 1,
    effort: 2,
    inNarrative: false,
    narrative: `${detail} on ${label}. The rate is stored and left out of the narrative.`,
  });
}

/**
 * @param {object} flag
 */
function finish(flag) {
  let confidence = flag.stable ? 3 : 2;
  if (flag.provisional) confidence -= 1;
  if (flag.insufficient) confidence = 1;
  confidence = Math.max(1, Math.min(5, confidence));
  const impact = Math.max(1, Math.min(5, flag.impact));
  const effort = Math.max(1, Math.min(5, flag.effort));
  return {
    ...flag,
    confidence,
    impact,
    effort,
    priority: impact + confidence + effort,
  };
}

/**
 * @param {{sessions: number, gap: number, mobile: boolean, prime: boolean}} input
 */
function impactOf(input) {
  const mass = input.sessions * Math.abs(input.gap);
  let score = 1;
  if (mass >= 5) score = 2;
  if (mass >= 20) score = 3;
  if (mass >= 50) score = 4;
  if (mass >= 100) score = 5;
  if (input.mobile) score += 1;
  if (input.prime) score += 1;
  return Math.min(5, score);
}

/**
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => string | number} key
 */
function groupBy(rows, key) {
  /** @type {Map<string, T[]>} */
  const out = new Map();
  for (const row of rows) {
    const id = String(key(row));
    const list = out.get(id) ?? [];
    list.push(row);
    out.set(id, list);
  }
  return out;
}
