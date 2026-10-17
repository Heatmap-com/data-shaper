/**
 * Judge a bundle folder against the anchors its builder wrote. Pure: the
 * profile and the orders CSV are strings and objects, never a warehouse read.
 */

const ATOM = /^(d|order_revenue|high_value)\s*(>=|<=|==)\s*(?:'([^']*)'|([0-9.]+))$/;

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {string} where
 * @returns {{column: string, op: string, value: string|number}[]}
 */
export function parseWhere(where) {
  return String(where ?? '').split(' and ').map((part) => {
    const match = ATOM.exec(part.trim());
    if (!match) throw new Error(`anchor where is not one the check evaluates: ${part.trim()}`);
    return { column: match[1], op: match[2], value: match[3] ?? Number(match[4]) };
  });
}

/**
 * Pandas writes a header and one record per line. A quoted field may contain
 * a comma. This does not split on commas.
 * @param {string} text
 * @returns {Record<string, string>[] & {header: string[]}}
 */
export function parseCsv(text) {
  const records = [];
  let field = '';
  let row = [];
  let quoted = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (row.some((cell) => cell !== '')) records.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') pushField();
    else if (char === '\n') pushRow();
    else if (char !== '\r') field += char;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  const header = records[0];
  if (!header?.includes('order_revenue')) throw new Error('01_orders.csv has no order_revenue column');
  const rows = records.slice(1).map((cells) => {
    const record = {};
    header.forEach((name, index) => {
      record[name] = cells[index] ?? '';
    });
    return record;
  });
  rows.header = header;
  return rows;
}

function cell(row, header, column) {
  if (column === 'd' && !header.includes('d')) return String(row.t_utc ?? '').slice(0, 10);
  return row[column];
}

function holds(row, header, atom) {
  const raw = cell(row, header, atom.column);
  if (atom.column === 'd' && (atom.op === '>=' || atom.op === '<=')) {
    const day = String(raw ?? '');
    return atom.op === '>=' ? day >= String(atom.value) : day <= String(atom.value);
  }
  if (atom.column === 'order_revenue' && atom.op === '>=') return Number(raw) >= Number(atom.value);
  if (atom.column === 'high_value' && atom.op === '==') return String(raw) === String(atom.value);
  return false;
}

function aggregate(rows, anchor) {
  if (anchor.agg === 'count') return rows.length;
  const values = rows.map((row) => Number(row[anchor.column])).filter((n) => Number.isFinite(n));
  if (anchor.agg === 'sum') return round2(values.reduce((sum, n) => sum + n, 0));
  if (anchor.agg === 'median') {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return round2(median);
  }
  throw new Error(`anchor agg is not one the check evaluates: ${anchor.agg}`);
}

/**
 * @param {object} profile parsed 00_site_profile.json
 * @param {string} csvText 01_orders.csv
 * @param {{start: string, end: string}} expectedWindow
 * @returns {{ok: boolean, summary: string, details: {name: string, ok: boolean, message: string}[]}}
 */
export function evaluateAnchors(profile, csvText, expectedWindow) {
  const details = [];
  const window = profile?.report_window;
  const windowOk = window?.start === expectedWindow.start && window?.end === expectedWindow.end;
  details.push({
    name: 'report_window',
    ok: windowOk,
    message: windowOk ? `${window.start} to ${window.end}` : `profile window ${window?.start} to ${window?.end}`,
  });
  if (!windowOk) {
    return { ok: false, summary: 'anchor mismatch: report window', details };
  }
  let rows;
  try {
    rows = parseCsv(csvText);
  } catch (err) {
    details.push({ name: '01_orders.csv', ok: false, message: err.message });
    return { ok: false, summary: `anchor mismatch: ${err.message}`, details };
  }
  for (const anchor of profile.anchors ?? []) {
    let got;
    let ok = true;
    let message = '';
    try {
      const matched = rows.filter((row) => parseWhere(anchor.where).every((atom) => holds(row, rows.header, atom)));
      got = aggregate(matched, anchor);
      ok = got === anchor.expect || (typeof got === 'number' && typeof anchor.expect === 'number'
        && Math.abs(got - anchor.expect) <= (anchor.tolerance ?? 0));
      message = ok ? String(got) : `got ${got}, expected ${anchor.expect}`;
    } catch (err) {
      ok = false;
      message = err.message;
    }
    details.push({ name: anchor.label, ok, message });
  }
  const bad = details.filter((row) => !row.ok);
  return {
    ok: bad.length === 0,
    summary: bad.length === 0 ? `${details.length - 1} anchor(s) hold` : `anchor mismatch: ${bad.map((row) => row.name).join(', ')}`,
    details,
  };
}
