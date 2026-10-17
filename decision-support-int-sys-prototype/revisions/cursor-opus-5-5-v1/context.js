import { h } from './views.js';

export const FAMILY_LABEL = {
  all: 'All visitors',
  traffic_source: 'Traffic source',
  returning: 'New or returning',
  buyer: 'Buyer',
  rager: 'Rager',
};

const DEVICES = [['all', 'All devices'], ['mobile', 'Mobile'], ['desktop', 'Desktop'], ['tablet', 'Tablet']];
const COMPARES = [['prev', 'Previous week'], ['avg4', '4-week average'], ['first', 'First week'], ['none', 'No comparison']];

export function defaultWeek(weeks, coverage) {
  const whole = weeks.filter((w) => coverage?.get(w) === 7);
  const list = whole.length ? whole : weeks;
  return list[list.length - 1];
}

export function readContext(hash, weeks, coverage, families) {
  const seg = families.includes(hash?.seg) ? hash.seg : 'all';
  return {
    wk: weeks.includes(hash?.wk) ? hash.wk : defaultWeek(weeks, coverage),
    cmp: COMPARES.some(([id]) => id === hash?.cmp) ? hash.cmp : 'prev',
    seg,
    segv: seg !== 'all' && hash?.segv ? hash.segv : '',
    dev: DEVICES.some(([id]) => id === hash?.dev) ? hash.dev : 'all',
  };
}

function valuesOf(rows, col, pred = () => true) {
  const seen = new Set();
  for (const r of rows) if (pred(r) && r[col] !== null && r[col] !== undefined && r[col] !== '') seen.add(String(r[col]));
  return seen;
}

export function contextChoice(panel, columns, rows, context, fieldMap) {
  const inherit = panel.inherit;
  const hide = new Set();
  const filter = {};
  const chips = [];
  let highlight = null;
  if (!inherit || !context) return { hide, filter, chips, highlight };
  const has = (col) => columns.includes(col);

  if (inherit.device) {
    const named = (panel.pickers ?? []).map((p) => p.field).find((f) => fieldMap.device.includes(f));
    const col = named && has(named) ? named : fieldMap.device.find(has);
    if (!col) chips.push("This table can't split by device; showing all devices.");
    else {
      hide.add(col);
      const want = context.dev || 'all';
      const present = valuesOf(rows, col);
      if (!present.has(want)) {
        chips.push(`This table can't split by ${want}; showing all devices.`);
        if (present.has('all')) filter[col] = 'all';
      } else filter[col] = want;
    }
  }

  if (inherit.segment) {
    if (!has('segment')) chips.push(`This table can't split by ${context.seg}; showing all visitors.`);
    else {
      hide.add('segment');
      hide.add('segment_value');
      const families = valuesOf(rows, 'segment');
      const fallback = (panel.pickers ?? []).find((p) => p.field === 'segment')?.default ?? 'all';
      if (inherit.segment === 'filter') {
        if (!context.seg || context.seg === 'all') {
          filter.segment = 'all';
          if (has('segment_value')) filter.segment_value = 'all';
        } else if (!families.has(context.seg)) {
          chips.push(`This table can't split by ${context.seg}; showing all visitors.`);
          filter.segment = 'all';
          if (has('segment_value')) filter.segment_value = 'all';
        } else if (!context.segv) filter.segment = context.seg;
        else if (!valuesOf(rows, 'segment_value', (r) => r.segment === context.seg).has(context.segv)) {
          chips.push(`This table can't split by ${context.segv}; showing all visitors.`);
          filter.segment = 'all';
          if (has('segment_value')) filter.segment_value = 'all';
        } else {
          filter.segment = context.seg;
          filter.segment_value = context.segv;
        }
      } else {
        const family = !context.seg || context.seg === 'all' ? fallback : context.seg;
        if (context.seg && context.seg !== 'all' && !families.has(context.seg)) {
          chips.push(`This table can't split by ${context.seg}; showing all visitors.`);
          filter.segment = fallback;
        } else {
          filter.segment = family;
          if (family === 'all' && has('segment_value')) filter.segment_value = 'all';
          if (context.seg && context.seg !== 'all' && context.segv) {
            if (valuesOf(rows, 'segment_value', (r) => String(r.segment) === String(family)).has(context.segv)) highlight = context.segv;
            else chips.push(`This table can't split by ${context.segv}; showing every value.`);
          }
        }
      }
    }
  }

  if (inherit.week && !fieldMap.week.some(has)) chips.push("This table can't filter by week.");
  return { hide, filter, chips, highlight };
}

function select(label, options, value, onchange) {
  return h('label', { class: 'picker' }, h('span', {}, label),
    h('select', { onchange: (e) => onchange(e.target.value) },
      options.map(([v, text]) => h('option', { value: v, selected: String(v) === String(value) ? 'selected' : null }, text))));
}

export function renderContext(host, { context, weeks, coverage, families, values, onChange, label }) {
  const set = (patch) => onChange({ ...context, ...patch });
  const weekLabel = (w) => `${label(w, 'week')} (${coverage?.get(w) ?? 7}/7 days)`;
  const controls = [
    select('Week', weeks.map((w) => [w, weekLabel(w)]), context.wk, (v) => set({ wk: v })),
    select('Compare with', COMPARES, context.cmp, (v) => set({ cmp: v })),
    select('Segment', families.map((f) => [f, FAMILY_LABEL[f] ?? f]), context.seg, (v) => set({ seg: v, segv: '' })),
  ];
  if (context.seg !== 'all') {
    controls.push(select('Value', [['', 'Every value (split)'], ...values.map((v) => [v, label(v, 'segment_value')])], context.segv, (v) => set({ segv: v })));
  }
  controls.push(select('Device', DEVICES, context.dev, (v) => set({ dev: v })));
  host.replaceChildren(...controls);
}
