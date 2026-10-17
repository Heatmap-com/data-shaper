export const ALL = '__all__';
export const NONE = '(none)';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => collator.compare(String(a ?? ''), String(b ?? ''));

export function toObjects({ columns, rows }) {
  return rows.map((r) => {
    const o = {};
    for (let i = 0; i < columns.length; i += 1) o[columns[i]] = r[i];
    return o;
  });
}

export function matches(row, filter = {}) {
  for (const [field, want] of Object.entries(filter)) {
    const have = String(row[field]);
    if (Array.isArray(want) ? !want.map(String).includes(have) : have !== String(want)) return false;
  }
  return true;
}

export function distinct(rows, field) {
  const seen = new Set();
  for (const r of rows) if (r[field] !== null && r[field] !== undefined) seen.add(r[field]);
  return [...seen].sort(naturalCompare);
}

// Pickers cascade: each picker's options come from the rows left by the pickers before it.
export function resolvePickers(rows, pickers = [], chosen = {}) {
  const resolved = [];
  let current = rows;
  for (const p of pickers) {
    const present = distinct(current, p.field).map(String);
    const options = p.options ? p.options.filter((o) => present.includes(String(o))) : present;
    const values = p.allowAll ? [ALL, ...options] : options;
    const has = (v) => v !== undefined && values.includes(String(v));
    const value = has(chosen[p.field]) ? String(chosen[p.field])
      : has(p.default) ? String(p.default)
        : values[0];
    resolved.push({ ...p, options: values, value });
    if (value !== undefined && value !== ALL) current = current.filter((r) => String(r[p.field]) === value);
  }
  return { rows: current, pickers: resolved };
}

export function measureColumns(def) {
  if (def.sum) return [def.sum];
  if (def.share) return [def.share];
  if (def.ratio) return def.ratio;
  return [];
}

export function aggregate(rows, keys, defs, minField) {
  const cols = [...new Set(defs.flatMap(measureColumns))];
  const groups = new Map();
  for (const r of rows) {
    const id = keys.map((k) => r[k]).join('\u0001');
    let g = groups.get(id);
    if (!g) {
      g = { key: Object.fromEntries(keys.map((k) => [k, r[k]])), sums: {}, count: 0, first: r, min: Infinity };
      for (const c of cols) g.sums[c] = 0;
      groups.set(id, g);
    }
    g.count += 1;
    for (const c of cols) g.sums[c] += Number(r[c]) || 0;
    if (minField && r[minField] !== null && Number(r[minField]) < g.min) g.min = Number(r[minField]);
  }
  return [...groups.values()];
}

// shareTotals: column sums over the whole slice, for share measures.
export function measureValue(def, g, shareTotals = {}) {
  if (!g) return null;
  if (def.count) return g.count;
  if (def.sum) return g.sums[def.sum];
  if (def.share) return shareTotals[def.share] ? g.sums[def.share] / shareTotals[def.share] : null;
  if (def.ratio) {
    const den = g.sums[def.ratio[1]];
    return den ? g.sums[def.ratio[0]] / den : null;
  }
  return null;
}

export function totals(rows, defs) {
  const cols = [...new Set(defs.flatMap(measureColumns))];
  const out = {};
  for (const c of cols) out[c] = rows.reduce((s, r) => s + (Number(r[c]) || 0), 0);
  return out;
}

const moneyFormatters = new Map();
function moneyFormat(currency, digits) {
  const key = `${currency}|${digits}`;
  if (!moneyFormatters.has(key)) {
    moneyFormatters.set(key, new Intl.NumberFormat(undefined, {
      style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits,
    }));
  }
  return moneyFormatters.get(key);
}

export function format(v, fmt, currency = 'USD') {
  if (v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v))) return '–';
  if (typeof v !== 'number') {
    if (fmt && fmt !== 'text' && !Number.isNaN(Number(v))) v = Number(v);
    else return String(v);
  }
  switch (fmt) {
    case 'int': return Math.round(v).toLocaleString();
    case 'money': return moneyFormat(currency, Math.abs(v) >= 100 ? 0 : 2).format(v);
    case 'pct': return `${(v * 100).toFixed(Math.abs(v) < 0.1 ? 2 : 1)}%`;
    case 'num': return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    default: return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 3 });
  }
}

export function priorWeeks(weeks, week, mode) {
  const idx = weeks.indexOf(week);
  if (idx <= 0 || mode === 'none') return [];
  if (mode === 'first') return [weeks[0]];
  if (mode === 'avg4') return weeks.slice(Math.max(0, idx - 4), idx);
  return [weeks[idx - 1]];
}

export function change(cur, prev, fmt) {
  if (cur === null || prev === null || cur === undefined || prev === undefined) return null;
  if (fmt === 'pct') return { value: (cur - prev) * 100, unit: 'pp', dir: Math.sign(cur - prev) };
  if (!prev) return null;
  return { value: ((cur - prev) / Math.abs(prev)) * 100, unit: '%', dir: Math.sign(cur - prev) };
}
