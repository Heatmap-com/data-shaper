/**
 * Dataset rows for product-grid. Cell rows keep the week. Prior rows are
 * the leave-one-out pool for the block they exclude. Flag rows are the
 * window. A narrative row is the diagnose-then-test list.
 */

import { priorKey } from './baseline.js';

/**
 * @param {object} input
 */
export function toProductGridRows(input) {
  const { weekRows, windowCells, priors, flags, narrative, botFilter } = input;
  /** @type {object[]} */
  const rows = [];

  for (const cell of weekRows) {
    rows.push({
      dims: {
        week: cell.week,
        device: cell.device,
        selector: cell.selector,
        bot_filter: botFilter,
        row_kind: 'cell',
        block_id: cell.blockId,
        slot: cell.slot,
      },
      metrics: cellMetrics(cell),
    });
  }

  const seenPrior = new Set();
  for (const cell of windowCells) {
    const bag = priors.get(`${cell.blockId}|${cell.device}`);
    const prior = bag?.get(priorKey(cell));
    if (!prior) continue;
    const dims = {
      device: cell.device,
      bot_filter: botFilter,
      row_kind: 'prior',
      block_id: cell.blockId,
      slot: '',
      layout: cell.layout,
      col: String(cell.col),
      depth_band: cell.depthBand,
      in_capture: String(cell.inCapture),
    };
    const priorId = JSON.stringify(dims);
    if (seenPrior.has(priorId)) continue;
    seenPrior.add(priorId);
    rows.push({
      dims,
      metrics: {
        baseline_ctr: round4(prior.ctr),
        clicking_sessions: prior.clicking,
        reached_sessions: prior.reached,
        eligible: prior.eligible ? 1 : 0,
        prior_scope: prior.priorScope,
        donor_blocks: prior.donorBlockIds.length,
        donor_pages: prior.donorPages,
        name_at_capture: true,
      },
    });
  }

  for (const flag of flags) {
    rows.push({
      dims: {
        device: flag.device,
        bot_filter: botFilter,
        row_kind: 'flag',
        block_id: flag.blockId,
        slot: flag.slot || '',
        rule: flag.rule,
        flag_key: `${flag.rule}|${flag.device}|${(flag.slots || []).join('+')}|${flag.exposure ? 'exposure' : flag.action}`,
      },
      metrics: {
        rule: flag.rule,
        layout: flag.layout,
        slots: (flag.slots || []).join(','),
        action: flag.action,
        rung: flag.rung,
        stable: flag.stable ? 1 : 0,
        provisional: flag.provisional ? 1 : 0,
        insufficient: flag.insufficient ? 1 : 0,
        exposure: flag.exposure ? 1 : 0,
        held: flag.held ? 1 : 0,
        lift_form: flag.liftForm ? 1 : 0,
        in_narrative: flag.inNarrative ? 1 : 0,
        name_at_capture: true,
        prior_scope: flag.priorScope || '',
        impact: flag.impact,
        confidence: flag.confidence,
        effort: flag.effort,
        priority: flag.priority,
        narrative: flag.narrative,
      },
    });
  }

  if (narrative) {
    rows.push({
      dims: {
        device: '',
        bot_filter: botFilter,
        row_kind: 'narrative',
        block_id: '',
        slot: '',
      },
      metrics: { narrative, name_at_capture: true },
    });
  }

  return rows;
}

/**
 * @param {object} cell
 */
function cellMetrics(cell) {
  return {
    layout: cell.layout,
    block_label: cell.blockLabel,
    name: cell.name,
    name_at_capture: true,
    row: cell.row,
    col: cell.col,
    x: cell.x,
    y: cell.y,
    w: cell.w,
    h: cell.h,
    in_capture: cell.inCapture,
    depth_band: cell.depthBand,
    columns: cell.columns,
    rows: cell.rows,
    template_start: cell.templateStart,
    clicking_sessions: cell.clicking,
    quick_add_sessions: cell.quickAdd,
    qv_submit_sessions: cell.qvSubmit,
    orders: cell.orders,
    revenue_udp: round2(cell.revenue || 0),
    row_reach: round4(cell.rowReach || 0),
    reached_sessions: cell.reached || 0,
    entry_sessions: cell.entrySessions || 0,
  };
}

/**
 * @param {number} n
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * @param {number} n
 */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}
