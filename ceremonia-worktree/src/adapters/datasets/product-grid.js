/**
 * product-grid: layout class, cell rollup, leave-one-out column prior,
 * and the grid flags that prior can support. The prior for a block is the
 * other blocks of the same layout on this site, with this block left out.
 * On a site whose only captured page is one homepage, that prior is the
 * other carousel on the same page, and a column is eligible at 20 clicking
 * sessions. R5, R6, R9, and R10 are not emitted.
 */

import { deviceName } from '../_lib/dims.js';
import { configuredDatabase } from '../query-gateway/clickhouse.js';
import { getClickRows } from '../_lib/clicks.js';
import { fetchSessionRows, filtersFor } from '../_lib/session-stream.js';
import { buildPriors } from '../../product-grid/baseline.js';
import { classifyPage } from '../../product-grid/classify.js';
import { evaluateGrid } from '../../product-grid/flags.js';
import { rollup } from '../../product-grid/rollup.js';
import { toProductGridRows } from '../../product-grid/rows.js';
import { templateStartFromDaily } from '../../product-grid/template-start.js';

const BOT_FILTER = 'exclude_confirmed';

export const adapter = {
  id: 'product-grid',
  dependsOn: ['element-binding', 'render-snapshot'],
  scope: 'page',

  /**
   * @param {import('../../../ports/qualifier.js').QualifiedPage} page
   * @param {import('../../../ports/dataset.js').RunContext} ctx
   */
  async collect(page, ctx) {
    const geometry = await loadGeometry(page, ctx);
    const blocks = classifyPage(geometry.boxes, geometry.viewports);
    if (blocks.length === 0) {
      return {
        id: adapter.id,
        rows: [],
        notes: { product_grid_note: 'no product_tile block with a captured box' },
      };
    }

    const lookback = shiftDays(ctx.windowStart, -120);
    const prefixes = [...new Set(blocks.map((block) => block.blockId))];
    const [dailyByPrefix, clicks, sessions, pageviewRows] = await Promise.all([
      Promise.all(prefixes.map((prefix) => dailyCounts(ctx, page, prefix, lookback))),
      getClickRows(ctx, page),
      fetchSessionRows(ctx, page.idsite),
      fetchPageviews(ctx, page),
    ]);

    const templateByPrefix = new Map(prefixes.map((prefix, i) => [prefix, templateStartFromDaily(dailyByPrefix[i])]));
    for (const block of blocks) {
      const found = templateByPrefix.get(block.blockId);
      block.templateStart = found && found > ctx.windowStart ? found : ctx.windowStart;
    }

    const hsr = String(page.idsitehsr);
    /** @type {Map<string, object>} */
    const kept = new Map();
    for (const session of sessions) {
      if (session.entryHsr !== hsr) continue;
      if (!filtersFor(session.tier).includes(BOT_FILTER)) continue;
      kept.set(session.idvisit, session);
    }

    // rollup walks the clicks once per grid cell; each walk reads the
    // click table afresh through this view.
    const clickRows = {
      *[Symbol.iterator]() {
        for (const click of clicks) {
          const session = kept.get(click.idvisit);
          if (!session) continue;
          yield {
            idvisit: click.idvisit,
            selector: click.selector,
            date: String(click.date).slice(0, 10),
            week: String(click.week).slice(0, 10),
            device: deviceName(session.device),
            orders: session.orders,
            revenue: session.revenue,
          };
        }
      },
    };

    const pageviews = [];
    for (const view of pageviewRows) {
      const session = kept.get(String(view.idvisit));
      if (!session) continue;
      const scrollPx = (Number(view.scroll_y) / 1000) * Number(view.scroll_height);
      pageviews.push({
        idvisit: String(view.idvisit),
        device: deviceName(session.device),
        date: String(view.date).slice(0, 10),
        reachedPx: scrollPx + Number(view.viewport_h),
      });
    }

    const { windowCells, weekRows } = rollup(blocks, clickRows, pageviews, midpoint(ctx.windowStart, ctx.windowEnd));
    const counted = countedBlocks(windowCells);
    const priors = buildPriors(counted);
    const { flags, narrative } = evaluateGrid(windowCells, priors, counted);
    const scopes = [...priors.values()].flatMap((bag) => [...bag.values()].map((prior) => prior.priorScope));
    const priorScope = scopes.includes('other_pages') ? 'other_pages' : scopes.includes('same_page_blocks') ? 'same_page_blocks' : 'none';

    return {
      id: adapter.id,
      rows: toProductGridRows({
        weekRows,
        windowCells,
        priors,
        flags,
        narrative,
        botFilter: BOT_FILTER,
      }),
      notes: {
        product_grid_blocks: counted.length,
        product_grid_prior_scope: priorScope,
        product_grid_template_start: Object.fromEntries(
          [...templateByPrefix.entries()].map(([prefix, date]) => [prefix, date ?? '']),
        ),
        product_grid_flags: flags.filter((flag) => flag.inNarrative).length,
      },
    };
  },
};

/**
 * @param {object[]} windowCells
 */
function countedBlocks(windowCells) {
  /** @type {Map<string, object>} */
  const groups = new Map();
  for (const cell of windowCells) {
    const key = `${cell.blockId}|${cell.device}`;
    let block = groups.get(key);
    if (!block) {
      block = {
        blockId: cell.blockId,
        pageId: cell.pageId,
        device: cell.device,
        layout: cell.layout,
        cells: [],
      };
      groups.set(key, block);
    }
    block.cells.push(cell);
  }
  return [...groups.values()];
}

/**
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 */
async function loadGeometry(page, ctx) {
  const binding = stored(ctx, 'element-binding');
  const render = stored(ctx, 'render-snapshot');
  if (binding && render) return geometryFromRows(binding.rows, render.rows, page);

  const params = { idsite: page.idsite, idsitehsr: page.idsitehsr };
  const [bindings, renders, nodes] = await Promise.all([
    ctx.gateway.query(
      `SELECT selector, element_class, any(name) AS name
         FROM ${configuredDatabase()}.ae_element_binding_current
        WHERE idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}
        GROUP BY selector, element_class`,
      params,
      'product-grid:bindings',
    ),
    ctx.gateway.query(
      `SELECT device_class, viewport_w, viewport_h
         FROM ${configuredDatabase()}.ae_page_render_current
        WHERE idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}`,
      params,
      'product-grid:renders',
    ),
    ctx.gateway.query(
      `SELECT device_class, selector, x, y, w, h
         FROM ${configuredDatabase()}.ae_render_node_current
        WHERE idsite = {idsite:UInt32} AND idsitehsr = {idsitehsr:UInt64}
          AND node_kind = 'element'`,
      params,
      'product-grid:nodes',
    ),
  ]);
  const bindingRows = bindings
    .filter((row) => String(row.element_class) === 'product_tile')
    .map((row) => ({
      dims: { selector: String(row.selector ?? ''), element_class: 'product_tile' },
      metrics: { name: String(row.name ?? '') },
    }));
  const renderRows = [
    ...renders.map((row) => ({
      dims: { device_class: String(row.device_class ?? '') },
      metrics: { viewport_w: Number(row.viewport_w ?? 0), viewport_h: Number(row.viewport_h ?? 0) },
    })),
    ...nodes.map((row) => ({
      dims: {
        device_class: String(row.device_class ?? ''),
        node_kind: 'element',
        selector: String(row.selector ?? ''),
      },
      metrics: { x: Number(row.x ?? 0), y: Number(row.y ?? 0), w: Number(row.w ?? 0), h: Number(row.h ?? 0) },
    })),
  ];
  return geometryFromRows(bindingRows, renderRows, page);
}

/**
 * @param {object[]} bindingRows
 * @param {object[]} renderRows
 * @param {{idsitehsr: number}} page
 */
function geometryFromRows(bindingRows, renderRows, page) {
  const names = new Map();
  for (const row of bindingRows) {
    if (row.dims?.element_class !== 'product_tile') continue;
    names.set(row.dims.selector, String(row.metrics?.name ?? ''));
  }
  /** @type {Map<string, {width: number, height: number}>} */
  const viewports = new Map();
  for (const row of renderRows) {
    const device = row.dims?.device_class;
    if (!device || row.dims?.node_kind) continue;
    if (row.metrics?.viewport_w == null) continue;
    viewports.set(device, { width: Number(row.metrics.viewport_w), height: Number(row.metrics.viewport_h) });
  }
  /** @type {object[]} */
  const boxes = [];
  for (const row of renderRows) {
    if (row.dims?.node_kind !== 'element') continue;
    const selector = row.dims.selector;
    if (!names.has(selector)) continue;
    const device = row.dims.device_class;
    if (!viewports.has(device)) continue;
    boxes.push({
      selector,
      name: names.get(selector),
      device,
      x: Number(row.metrics.x),
      y: Number(row.metrics.y),
      w: Number(row.metrics.w),
      h: Number(row.metrics.h),
    });
  }
  return {
    boxes,
    viewports: [...viewports.entries()].map(([device, size]) => ({
      device,
      width: size.width,
      height: size.height,
      pageId: String(page.idsitehsr),
    })),
  };
}

/**
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 * @param {string} prefix
 * @param {string} lookback
 */
function dailyCounts(ctx, page, prefix, lookback) {
  return ctx.gateway.query(
    `SELECT toString(server_date) AS date, count() AS clicks
       FROM default.udp_clicksce_clicks
      WHERE idsite = {idsite:UInt32}
        AND idsitehsr = {idsitehsr:UInt64}
        AND server_date BETWEEN {lookback:Date} AND {w1:Date}
        AND startsWith(idselector, {prefix:String})
      GROUP BY server_date
      ORDER BY server_date`,
    {
      idsite: page.idsite,
      idsitehsr: page.idsitehsr,
      lookback,
      w1: ctx.windowEnd,
      prefix,
    },
    'product-grid:template-start',
  );
}

/**
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {{idsite: number, idsitehsr: number}} page
 */
function fetchPageviews(ctx, page) {
  return ctx.gateway.query(
    `SELECT toString(idvisit) AS idvisit,
            toString(server_date) AS date,
            ifNull(scroll_y_max_relative, 0) AS scroll_y,
            ifNull(scroll_height, 0) AS scroll_height,
            ifNull(viewport_h_px, 0) AS viewport_h
       FROM default.udp_hsrce_pageviews
      WHERE idsite = {idsite:UInt32}
        AND idsitehsr = {idsitehsr:UInt64}
        AND server_date BETWEEN {w0:Date} AND {w1:Date}`,
    { idsite: page.idsite, idsitehsr: page.idsitehsr, w0: ctx.windowStart, w1: ctx.windowEnd },
    'product-grid:pageviews',
  );
}

/**
 * @param {import('../../../ports/dataset.js').RunContext} ctx
 * @param {string} id
 */
function stored(ctx, id) {
  const bag = ctx.datasets;
  if (!bag) return null;
  if (typeof bag.get === 'function') return bag.get(id) ?? null;
  return bag[id] ?? null;
}

/**
 * @param {string} iso
 * @param {number} days
 */
function shiftDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * @param {string} w0
 * @param {string} w1
 */
function midpoint(w0, w1) {
  const start = Date.parse(`${w0}T00:00:00Z`);
  const end = Date.parse(`${w1}T00:00:00Z`);
  return new Date(Math.floor((start + end) / 2)).toISOString().slice(0, 10);
}
