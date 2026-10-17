import { describe, expect, it } from 'vitest';
import { buildPriors } from '../src/product-grid/baseline.js';
import { classifyPage } from '../src/product-grid/classify.js';
import { evaluateGrid } from '../src/product-grid/flags.js';
import { clickPart, rollup } from '../src/product-grid/rollup.js';
import { templateStartFromDaily } from '../src/product-grid/template-start.js';

const DRESSES = 'main#MainContent > div.featured-lifestyle > div.carousel';
const SWEATERS = 'main#MainContent > div.featured-sweaters > div.carousel';
const NAMES = ['Abigail', 'Cosette', 'Sana', 'Koren', 'Nathalie', 'Margot', 'Diane', 'Sana 2'];
const DESKTOP_X = [347, 677, 1007, 1337, 1668, 1998, 2328, 2658];
const MOBILE_X = [16, 329, 643, 956, 1270, 1583, 1896, 2210];
const DESKTOP_CLICKS = [33, 40, 25, 7, 10, 6, 5, 38];
const MOBILE_CLICKS = [76, 62, 23, 37, 57, 28, 18, 28];

/**
 * @param {string} block
 * @param {string} device
 * @param {number} y
 * @param {string[]} names
 */
function carouselBoxes(block, device, y, names) {
  const xs = device === 'desktop' ? DESKTOP_X : MOBILE_X;
  const w = device === 'desktop' ? 314 : 297;
  const h = device === 'desktop' ? 530 : 400;
  return names.map((name, i) => ({
    selector: `${block} > div:nth-child(${i + 1})`,
    name,
    device,
    x: xs[i],
    y,
    w,
    h,
  }));
}

function viewports(pageId = '51247422') {
  return [
    { device: 'desktop', width: 1440, height: 900, pageId },
    { device: 'mobile', width: 390, height: 700, pageId },
  ];
}

/**
 * @param {object[]} blocks
 * @param {number[][]} clicksByDevice desktop then mobile, per slot
 */
function withClicks(blocks, clicksByDevice) {
  const devices = ['desktop', 'mobile'];
  return blocks.flatMap((block) => {
    const deviceIndex = devices.indexOf(block.device);
    const counts = clicksByDevice[deviceIndex];
    if (!counts) return [];
    return block.cells.map((cell, i) => {
      const clicking = counts[i] ?? 0;
      const early = Math.ceil(clicking / 2);
      return {
        ...cell,
        clicking,
        orders: 0,
        reached: 500,
        rowReach: 0.8,
        entrySessions: 1000,
        earlyClicking: early,
        lateClicking: clicking - early,
      };
    });
  });
}

describe('classifyPage', () => {
  const boxes = [
    ...carouselBoxes(DRESSES, 'desktop', 910, NAMES),
    ...carouselBoxes(DRESSES, 'mobile', 686, NAMES),
    ...carouselBoxes(SWEATERS, 'desktop', 1606, NAMES.map((name) => `Sweater ${name}`)),
    {
      selector: `${DRESSES} > div:nth-child(1) > button.quick-add`,
      name: 'Button - Quick Add Product Tile Grid Best',
      device: 'desktop',
      x: 400,
      y: 1200,
      w: 80,
      h: 40,
    },
  ];
  const blocks = classifyPage(boxes, viewports());

  it('keeps dresses and sweaters as separate carousels and drops the quick-add box', () => {
    const dresses = blocks.filter((block) => block.blockId.includes('featured-lifestyle'));
    const sweaters = blocks.filter((block) => block.blockId.includes('featured-sweaters'));
    expect(dresses.map((block) => block.layout)).toEqual(['carousel', 'carousel']);
    expect(sweaters.map((block) => block.layout)).toEqual(['carousel']);
    expect(dresses[0].cells).toHaveLength(8);
    expect(dresses[0].cells.some((cell) => cell.selector.includes('quick-add'))).toBe(false);
  });

  it('keeps the slides when a section title is also classed product_tile, and skips the cart drawer', () => {
    const parent = 'main#MainContent > div:nth-child(3) > section > div > div.featured-lifestyle__content';
    const slide = `${parent} > div.featured-lifestyle__carousel-outer > div > div:nth-child(1)`;
    const slide2 = slide.replace('nth-child(1)', 'nth-child(2)');
    const boxes = [
      { selector: parent, name: 'Sweaters & Knits Product Tile', device: 'desktop', x: 0, y: 1500, w: 1400, h: 600 },
      { selector: slide, name: 'Flavia Knit Wrap Top Product Tile', device: 'desktop', x: 347, y: 1606, w: 314, h: 530 },
      { selector: `${slide} > div.product-information`, name: 'Flavia variants Product Tile', device: 'desktop', x: 347, y: 2000, w: 314, h: 80 },
      { selector: `${slide} > button.quick-add`, name: 'Button - Quick Add Product Tile', device: 'desktop', x: 400, y: 1900, w: 70, h: 36 },
      { selector: slide2, name: 'Wrigley Knit Sweater Product Tile', device: 'desktop', x: 677, y: 1606, w: 314, h: 530 },
      { selector: `${slide2} > div.product-information`, name: 'Wrigley variants Product Tile', device: 'desktop', x: 677, y: 2000, w: 314, h: 80 },
      { selector: 'cart-drawer#cart-drawer > collapsible-elements > div:nth-child(1)', name: 'Bag Item Product Tile', device: 'desktop', x: 10, y: 40, w: 300, h: 80 },
      { selector: 'cart-drawer#cart-drawer > collapsible-elements > div:nth-child(2)', name: 'Bag Item Two Product Tile', device: 'desktop', x: 10, y: 140, w: 300, h: 80 },
    ];
    const found = classifyPage(boxes, viewports());
    expect(found.every((block) => !block.blockId.includes('cart-drawer'))).toBe(true);
    expect(found[0].cells.map((cell) => cell.name)).toEqual([
      'Flavia Knit Wrap Top Product Tile',
      'Wrigley Knit Sweater Product Tile',
    ]);
  });

  it('marks the desktop captured prefix and leaves C4 partial outside it', () => {
    const desktop = blocks.find((block) => block.blockId.includes('featured-lifestyle') && block.device === 'desktop');
    expect(desktop.cells.map((cell) => cell.inCapture)).toEqual([1, 1, 1, 0, 0, 0, 0, 0]);
    expect(desktop.cells[0].slot).toBe('C1');
    expect(desktop.cells[7].name).toBe('Sana 2');
    const mobile = blocks.find((block) => block.blockId.includes('featured-lifestyle') && block.device === 'mobile');
    expect(mobile.cells.map((cell) => cell.inCapture)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('layouts', () => {
  it('names a 4 by 2 with aligned origins wrapped', () => {
    const boxes = [];
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 4; col++) {
        boxes.push({
          selector: `main > div.grid > div:nth-child(${row * 4 + col + 1})`,
          name: `P${row * 4 + col + 1}`,
          device: 'desktop',
          x: 10 + col * 190,
          y: 100 + row * 300,
          w: 180,
          h: 200,
        });
      }
    }
    const [block] = classifyPage(boxes, [{ device: 'desktop', width: 800, height: 700, pageId: 'p' }]);
    expect(block.layout).toBe('wrapped');
    expect(block.cells.find((cell) => cell.slot === 'C5').row).toBe(2);
    expect(block.cells.find((cell) => cell.slot === 'C5').col).toBe(1);
  });

  it('names a stack single_column', () => {
    const boxes = [0, 1, 2, 3].map((i) => ({
      selector: `main > div.stack > div:nth-child(${i + 1})`,
      name: `P${i + 1}`,
      device: 'mobile',
      x: 10,
      y: 100 + i * 320,
      w: 300,
      h: 200,
    }));
    const [block] = classifyPage(boxes, [{ device: 'mobile', width: 390, height: 700, pageId: 'p' }]);
    expect(block.layout).toBe('single_column');
    expect(block.cells).toHaveLength(4);
  });

  it('names staggered origins irregular and emits no flags', () => {
    const boxes = [
      { selector: 'main > div.odd > div:nth-child(1)', name: 'A', device: 'desktop', x: 10, y: 100, w: 200, h: 200 },
      { selector: 'main > div.odd > div:nth-child(2)', name: 'B', device: 'desktop', x: 220, y: 100, w: 200, h: 200 },
      { selector: 'main > div.odd > div:nth-child(3)', name: 'C', device: 'desktop', x: 700, y: 500, w: 200, h: 200 },
      { selector: 'main > div.odd > div:nth-child(4)', name: 'D', device: 'desktop', x: 920, y: 500, w: 200, h: 200 },
    ];
    const [block] = classifyPage(boxes, [{ device: 'desktop', width: 1440, height: 900, pageId: 'p' }]);
    expect(block.layout).toBe('irregular');
    const { flags } = evaluateGrid(block.cells.map((cell) => ({ ...cell, clicking: 30, reached: 100, earlyClicking: 15, lateClicking: 15, orders: 0, rowReach: 0.5 })), new Map());
    expect(flags).toEqual([]);
  });
});

describe('templateStartFromDaily', () => {
  it('starts the dense run after a stray pair of clicks', () => {
    const daily = [
      { date: '2026-09-01', clicks: 2 },
      { date: '2026-09-14', clicks: 400 },
      { date: '2026-09-15', clicks: 500 },
    ];
    expect(templateStartFromDaily(daily)).toBe('2026-09-14');
  });

  it('keeps a one-click first day when the next day continues the run', () => {
    expect(templateStartFromDaily([
      { date: '2026-09-14', clicks: 1 },
      { date: '2026-09-15', clicks: 4 },
      { date: '2026-09-16', clicks: 19 },
    ])).toBe('2026-09-14');
  });
});

describe('dresses flags', () => {
  const blocks = classifyPage(
    [
      ...carouselBoxes(DRESSES, 'desktop', 910, NAMES),
      ...carouselBoxes(DRESSES, 'mobile', 686, NAMES),
    ],
    viewports(),
  );
  const cells = withClicks(blocks, [DESKTOP_CLICKS, MOBILE_CLICKS]);
  cells.find((cell) => cell.device === 'desktop' && cell.slot === 'C8').orders = 2;
  cells.find((cell) => cell.device === 'mobile' && cell.slot === 'C2').orders = 1;
  cells.find((cell) => cell.device === 'mobile' && cell.slot === 'C4').orders = 1;

  const { flags, narrative } = evaluateGrid(cells, new Map());

  it('emits one exposure flag for desktop C4 through C7', () => {
    const exposure = flags.filter((flag) => flag.rule === 'R2' && flag.exposure);
    expect(exposure).toHaveLength(1);
    expect(exposure[0].slots).toEqual(['C4', 'C5', 'C6', 'C7']);
    expect(exposure[0].action).toBe('diagnose');
    expect(exposure[0].narrative).toMatch(/off-screen/);
  });

  it('keeps Sana and Sana 2 as name-joined hypotheses and leaves R3 off without a prior', () => {
    const cellsFlags = flags.filter((flag) => flag.rule === 'R2' && !flag.exposure && flag.inNarrative);
    expect(cellsFlags.map((flag) => flag.slot).sort()).toEqual(['C3', 'C8']);
    expect(narrative).toMatch(/Identity is unconfirmed/);
    expect(narrative).toMatch(/Sana 2/);
    expect(flags.some((flag) => flag.rule === 'R3')).toBe(false);
    expect(flags.some((flag) => ['R5', 'R6', 'R9', 'R10'].includes(flag.rule))).toBe(false);
  });

  it('leaves the one-order pair out of the narrative and stores the Abigail watch', () => {
    expect(narrative).not.toMatch(/1 order/);
    expect(narrative).not.toMatch(/\d+\/\d+/);
    const watch = flags.find((flag) => flag.rule === 'R4' && flag.slot === 'C1' && flag.device === 'mobile');
    expect(watch?.inNarrative).toBe(false);
    expect(watch?.action).toBe('watch');
  });
});

describe('baseline', () => {
  it('leaves the judged block out and stays ineligible under 20 donor clicks', () => {
    const blocks = [
      block('dresses', 'desktop', 8, 30),
      block('sweaters', 'desktop', 8, 19),
    ];
    const priors = buildPriors(blocks);
    const prior = priors.get('dresses|desktop').get('carousel|c8|0');
    expect(prior.eligible).toBe(false);
    expect(prior.clicking).toBe(19);
    expect(prior.priorScope).toBe('same_page_blocks');
    expect(prior.donorBlockIds).toEqual(['sweaters']);
  });

  it('turns on R3 when the other carousel clears the column gate', () => {
    const dresses = classifyPage(carouselBoxes(DRESSES, 'desktop', 910, NAMES), [
      { device: 'desktop', width: 1440, height: 900, pageId: 'home' },
    ]);
    const sweaters = classifyPage(
      carouselBoxes(SWEATERS, 'desktop', 1606, NAMES.map((name) => `Sweater ${name}`)),
      [{ device: 'desktop', width: 1440, height: 900, pageId: 'home' }],
    );
    const cells = [
      ...withClicks(dresses, [DESKTOP_CLICKS.map(() => 10)]),
      ...withClicks(sweaters, [DESKTOP_CLICKS.map(() => 20)]),
    ];
    const sana = cells.find((cell) => cell.name === 'Sana 2');
    sana.clicking = 40;
    sana.earlyClicking = 20;
    sana.lateClicking = 20;
    const priors = buildPriors(counted(cells));
    const dressesOnly = cells.filter((cell) => cell.blockId.includes('featured-lifestyle'));
    const { flags } = evaluateGrid(dressesOnly, priors, counted(cells));
    const r3 = flags.filter((flag) => flag.rule === 'R3');
    expect(r3.map((flag) => flag.slot)).toEqual(['C8']);
    expect(r3[0].priorScope).toBe('same_page_blocks');
    expect(r3[0].narrative).toMatch(/other block on this page/);
  });
});

describe('rollup', () => {
  it('counts a descendant image once and keeps quick-add off the attention numerator', () => {
    const [block] = classifyPage(carouselBoxes(DRESSES, 'desktop', 910, NAMES).slice(0, 2), [
      { device: 'desktop', width: 1440, height: 900, pageId: 'home' },
    ]);
    block.templateStart = '2026-09-14';
    const cell = block.cells[0].selector;
    const { windowCells } = rollup(
      [block],
      [
        click('v1', cell, '2026-09-10'),
        click('v1', `${cell} > a > img`, '2026-09-15'),
        click('v1', `${cell} > button.quick-add`, '2026-09-15'),
        click('v2', `${cell} > a > img`, '2026-09-16'),
        click('v2', `${cell} > button.quick-add`, '2026-09-20'),
      ],
      [{ idvisit: 'v1', device: 'desktop', date: '2026-09-15', reachedPx: 2000 }],
      '2026-09-24',
    );
    expect(clickPart(`${cell} > button.quick-add`)).toBe('quick_add');
    expect(windowCells[0].clicking).toBe(2);
    expect(windowCells[0].quickAdd).toBe(2);
    expect(windowCells[0].earlyClicking).toBe(2);
    expect(windowCells[0].lateClicking).toBe(0);
  });
});

/**
 * @param {string} blockId
 * @param {string} device
 * @param {number} columns
 * @param {number} clicking
 */
function block(blockId, device, columns, clicking) {
  return {
    blockId,
    pageId: 'home',
    device,
    layout: 'carousel',
    cells: Array.from({ length: columns }, (_, i) => ({
      col: i + 1,
      depthBand: 'shared',
      inCapture: i < 3 ? 1 : 0,
      layout: 'carousel',
      clicking,
      reached: 400,
    })),
  };
}

/**
 * @param {object[]} cells
 */
function counted(cells) {
  const groups = new Map();
  for (const cell of cells) {
    const key = `${cell.blockId}|${cell.device}`;
    const existing = groups.get(key) ?? {
      blockId: cell.blockId,
      pageId: cell.pageId,
      device: cell.device,
      layout: cell.layout,
      cells: [],
    };
    existing.cells.push(cell);
    groups.set(key, existing);
  }
  return [...groups.values()];
}

/**
 * @param {string} idvisit
 * @param {string} selector
 * @param {string} date
 */
function click(idvisit, selector, date) {
  return {
    idvisit,
    selector,
    date,
    week: '2026-09-14',
    device: 'desktop',
    orders: 0,
    revenue: 0,
  };
}

describe('evaluateGrid characterization', () => {
  /** A rows-by-columns grid of 180 by 200 boxes on one device. */
  function gridBoxes(prefix, device, rows, columns, width) {
    const boxes = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        const i = row * columns + col;
        boxes.push({
          selector: `main > div.${prefix} > div:nth-child(${i + 1})`,
          name: `${prefix} ${i + 1}`,
          device,
          x: 10 + col * Math.floor(width / columns),
          y: 100 + row * 300,
          w: Math.floor(width / columns) - 10,
          h: 200,
        });
      }
    }
    return boxes;
  }

  function scenario(boxes, viewport, clicks) {
    const blocks = classifyPage(boxes, [viewport]);
    const cells = withClicks(blocks, viewport.device === 'desktop' ? [clicks] : [[], clicks]);
    return { blocks, cells };
  }

  it('keeps every flag for carousel, wrapped, single-column, and fitted-row blocks', () => {
    const dresses = classifyPage(
      [...carouselBoxes(DRESSES, 'desktop', 910, NAMES), ...carouselBoxes(DRESSES, 'mobile', 686, NAMES)],
      viewports(),
    );
    const dressCells = withClicks(dresses, [DESKTOP_CLICKS, MOBILE_CLICKS]);
    const wrapped = scenario(
      gridBoxes('grid', 'desktop', 3, 4, 800),
      { device: 'desktop', width: 800, height: 700, pageId: 'p' },
      [21, 22, 25, 90, 20, 23, 24, 80, 26, 40, 60, 95],
    );
    const column = scenario(
      gridBoxes('stack', 'mobile', 6, 1, 380),
      { device: 'mobile', width: 390, height: 700, pageId: 'p' },
      [21, 25, 30, 40, 60, 80],
    );
    const fitted = scenario(
      gridBoxes('row', 'desktop', 1, 6, 1400),
      { device: 'desktop', width: 1440, height: 900, pageId: 'p' },
      [21, 22, 25, 30, 60, 90],
    );
    const layouts = [dresses, wrapped.blocks, column.blocks, fitted.blocks].map((bs) => bs.map((b) => b.layout));
    const results = {
      layouts,
      dresses: evaluateGrid(dressCells, new Map()),
      wrapped: evaluateGrid(wrapped.cells, new Map(), wrapped.blocks),
      column: evaluateGrid(column.cells, new Map(), column.blocks),
      fitted: evaluateGrid(fitted.cells, new Map(), fitted.blocks),
    };
    expect(results).toMatchSnapshot();
  });
});

describe('clickPart', () => {
  it('names quick-add, the quick-view submit, and the image', () => {
    const cell = 'main > div.grid > div:nth-child(1)';
    expect(clickPart(`${cell} > button.quick-add`)).toBe('quick_add');
    expect(clickPart(`${cell} > button.Quick_Add`)).toBe('quick_add');
    expect(clickPart(`${cell} > button[aria-label="quick add"]`)).toBe('quick_add');
    expect(clickPart(`${cell} > div.rs-qv-panel > button.submit`)).toBe('qv_submit');
    expect(clickPart(`${cell} > div.rs-qv-panel > img`)).toBe('image');
    expect(clickPart(`${cell} > a > img`)).toBe('image');
    expect(clickPart(undefined)).toBe('image');
  });
});
