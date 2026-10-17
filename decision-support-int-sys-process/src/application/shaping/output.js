import { OTHER } from '../../domain/shaping/cells.js';

/**
 * The finished forms of a shaped dataset: the table (columns with their
 * meaning, and rows), CSV, the JSON an agent reads, the DATA.md a person
 * reads, and the ANSWER.md of a whole request set.
 */

const LAST = new Set([OTHER, '(unmatched)', '(unknown)', '']);
const GRAIN_TEXT = { day: 'day', week: 'week', month: 'month', quarter: 'quarter', window: 'window' };

/**
 * The dataset's columns, in order, each with what it means, and its rows.
 * @param {import('./plan.js').ShapePlan} plan
 * @param {{cells: import('../../domain/shaping/cells.js').Cell[], order: string[] | null}} built
 */
export function datasetTable(plan, built) {
  const p = plan.period;
  const segmented = plan.segmentations.length > 0;
  const columns = [];
  const add = (name, label, meaning) => columns.push({ name, label, meaning });
  if (p.rolling) add('period', 'Day', `The day. Its measures are the sums of the ${p.rolling} days ending on it.`);
  else add('period', 'Period start', `The first day of the ${GRAIN_TEXT[p.grain]}${p.grain === 'week' ? `, a ${p.weekStart === 'sunday' ? 'Sunday' : 'Monday'}` : ''}.`);
  add('period_end', 'Period end', p.rolling ? 'The same day.' : `The last day of the ${GRAIN_TEXT[p.grain]}.`);
  add('period_complete', 'Period complete', '1 when the window holds the whole period; 0 when the window cuts it, so its measures cover only the window\'s days.');
  if (segmented) {
    add('segment', 'Segment', 'The segmentation the row belongs to; all is every session. Read one segmentation at a time: summing across segmentations counts a session more than once.');
    add('segment_value', 'Segment value', 'The value of the segmentation; all on the all rows. The values of one segmentation partition its period and key.');
  }
  for (const attr of plan.byAttributes) add(attr.id, attr.label, `${attr.data}${plan.request.rank ? ` ${OTHER} is every ${attr.label.toLowerCase()} below the rank.` : ''}`);
  for (const id of plan.output) {
    const m = plan.measures.find((measure) => measure.id === id);
    add(id, m.label, m.kind === 'source' && segmented ? `${m.data} On segment all only.` : m.data);
    if (p.compare) {
      add(`${id}_previous`, `${m.label}, previous period`, `${m.label} in the period before.`);
      add(`${id}_change`, `${m.label}, change`, 'The relative change from the previous period, (now - before) / before; empty when the previous value is 0 or unknown.');
    }
  }
  const floors = Object.entries(plan.request.floor);
  if (floors.length > 0) add('below_floor', 'Below floor', `1 when the row has ${floors.map(([name, min]) => `${name} under ${min}`).join(' or ')}; read its ratios as noise.`);

  const ends = new Map(plan.periods.map((period) => [period.start, period]));
  const rows = sortCells(plan, built).map((cell) => {
    const period = ends.get(cell.period);
    const row = {
      period: cell.period,
      period_end: p.rolling ? cell.period : period.end,
      period_complete: period.complete ? 1 : 0,
    };
    if (segmented) {
      row.segment = cell.segment;
      row.segment_value = cell.value;
    }
    plan.by.forEach((id, i) => {
      row[id] = cell.keys[i];
    });
    for (const id of plan.output) {
      row[id] = tidy(cell.m[id]);
      if (p.compare) {
        row[`${id}_previous`] = tidy(cell.m[`${id}_previous`]);
        row[`${id}_change`] = tidy(cell.m[`${id}_change`]);
      }
    }
    if (floors.length > 0) row.below_floor = floors.some(([name, min]) => (cell.m[name] ?? 0) < min) ? 1 : 0;
    return row;
  });
  return { columns, rows };
}

/** Periods in order; all first, then each segmentation and its values in order; keys by rank, else by value. */
function sortCells(plan, built) {
  const periodIndex = new Map(plan.periods.map((period, i) => [period.start, i]));
  const segmentIndex = new Map([['all', -1], ...plan.segmentations.map((seg, i) => [seg.id, i])]);
  const valueIndex = new Map(plan.segmentations.map((seg) => [seg.id, new Map(seg.values.map((value, i) => [value, i]))]));
  const rankIndex = built.order ? new Map(built.order.map((key, i) => [key, i])) : null;
  const compareKeys = (a, b) => {
    for (let i = 0; i < a.length; i += 1) {
      const x = a[i];
      const y = b[i];
      if (x === y) continue;
      if (LAST.has(String(x)) !== LAST.has(String(y))) return LAST.has(String(x)) ? 1 : -1;
      if (typeof x === 'number' && typeof y === 'number') return x - y;
      return String(x).localeCompare(String(y));
    }
    return 0;
  };
  return [...built.cells].sort((a, b) => (periodIndex.get(a.period) - periodIndex.get(b.period))
    || (segmentIndex.get(a.segment) - segmentIndex.get(b.segment))
    || ((valueIndex.get(a.segment)?.get(a.value) ?? 0) - (valueIndex.get(b.segment)?.get(b.value) ?? 0))
    || (rankIndex ? (rankIndex.get(JSON.stringify(a.keys)) ?? 1e9) - (rankIndex.get(JSON.stringify(b.keys)) ?? 1e9) : 0)
    || compareKeys(a.keys, b.keys));
}

const andList = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** A note as a sentence; a note that opens with an identifier keeps its case. */
const sentence = (note) => `${/^[a-z]+\b(?![._])/.test(note) ? `${note[0].toUpperCase()}${note.slice(1)}` : note}.`;

const tidy = (value) => (value == null || Number.isNaN(value) ? null : Number(Number(value).toFixed(6)));

/** RFC 4180 CSV; an empty cell is an unknown value. */
export function toCsv(table) {
  const cell = (value) => {
    if (value == null) return '';
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const names = table.columns.map((column) => column.name);
  return `${[names.join(','), ...table.rows.map((row) => names.map((name) => cell(row[name])).join(','))].join('\n')}\n`;
}

/**
 * The dictionary a person reads beside the CSV.
 * @param {import('./plan.js').Answer & {plan: import('./plan.js').ShapePlan}} answer
 * @param {ReturnType<typeof datasetTable>} table
 * @param {object} built
 * @param {{read: Array<object>}} sources
 * @param {{today: string, kinds: ReadonlyMap<string, import('../../domain/shaping/sources.js').SourceKind>, quality?: string[]}} context
 *   `quality` is the data-quality section's lines, when the build was screened
 */
export function dataMarkdown(answer, table, built, sources, { today, kinds, quality }) {
  const plan = answer.plan;
  const p = plan.period;
  const time = [
    `by ${p.rolling ? `day, each the trailing ${p.rolling} days` : GRAIN_TEXT[p.grain]}`,
    p.grain === 'week' ? `weeks starting ${p.weekStart === 'sunday' ? 'Sunday' : 'Monday'}` : null,
    p.compare ? 'each measure beside the period before' : null,
  ].filter(Boolean).join(', ');
  const keyed = [
    'period',
    plan.segmentations.length > 0 ? '(segment, segment value)' : null,
    ...plan.byAttributes.map((attr) => attr.label.toLowerCase()),
  ].filter(Boolean);
  const lines = [
    `# ${plan.id}`,
    '',
    `> ${plan.request.question}`,
    '',
    `Built ${today} for idsite ${plan.idsite}${plan.slug ? ` (${plan.slug})` : ''}, ${plan.window.start} to ${plan.window.end}, ${time}. ${table.rows.length} rows in \`data.csv\`; the same rows, with this dictionary, in \`dataset.json\`.`,
    '',
    '## Rows',
    '',
    `One row per ${andList(keyed)}. A session is a visit's rows in one period, after the bot filter, with every attribute taken at its first action in that period.`,
  ];
  if (plan.filter) lines.push('', `Only sessions matching the filter count: \`${JSON.stringify(plan.filter)}\`.`);
  if (plan.request.rank) {
    const r = plan.request.rank;
    lines.push('', `Ranked: the top ${r.limit} ${plan.byAttributes.map((attr) => attr.label.toLowerCase()).join(' and ')} by ${r.by} (${r.order === 'desc' ? 'highest' : 'lowest'} first) over the window, on segment all.${built.folded > 0 ? ` ${built.folded} more ${r.other ? `are folded into ${OTHER}` : 'are left out'}.` : ''}`);
  }
  lines.push('', '## Columns', '', '| Column | Meaning |', '|---|---|', ...table.columns.map((column) => `| \`${column.name}\` | ${column.meaning} |`));
  if (plan.segmentations.length > 0) {
    lines.push('', '## Segmentations', '');
    for (const seg of plan.segmentations) lines.push(`- **${seg.id}** (${seg.label}): ${seg.descriptor.data} Values: ${seg.values.join(', ')}.`);
  }
  if (sources.read.length > 0) {
    lines.push('', '## Sources', '');
    for (const read of sources.read) {
      const kind = kinds.get(read.id);
      const span = read.coverage ? ` Covers ${read.coverage.start} to ${read.coverage.end}.` : '';
      lines.push(`- **${read.id}** (${kind.label}): ${kind.purpose} ${read.rows} rows read.${span} ${kind.data}`);
    }
  }
  lines.push('', '## Checks', '', `- Partition: ${built.checks.partition}.`);
  for (const text of built.checks.conservation) lines.push(`- Conservation: ${text}.`);
  if (quality) lines.push('', '## Data quality', '', ...quality);
  if (answer.notes.length > 0) lines.push('', '## Read with care', '', ...answer.notes.map((note) => `- ${sentence(note)}`));
  lines.push('', '## Request', '', '```json', JSON.stringify(plan.request, null, 2), '```', '');
  return lines.join('\n');
}

const STATUS_TEXT = {
  built: 'Built',
  ready: 'Ready to build',
  read: 'Already stored: read it',
  blocked: 'Blocked',
  needs_person: 'Needs a person',
  invalid: 'Invalid request',
  failed: 'Failed a check',
};

/**
 * The answer to a request set, for a person: each request under its status,
 * with where its data is, what blocks it, or what a person must add.
 * @param {Array<import('./plan.js').Answer & {folder?: string, rows?: number}>} answers
 * @param {{today: string, from: string}} context
 */
export function answerMarkdown(answers, { today, from }) {
  const counts = Object.keys(STATUS_TEXT).map((status) => [status, answers.filter((a) => a.status === status).length]).filter(([, n]) => n > 0);
  const lines = [
    '# Dataset requests',
    '',
    `${answers.length} requests from \`${from}\`, answered ${today}: ${counts.map(([status, n]) => `${n} ${STATUS_TEXT[status].toLowerCase()}`).join(', ')}.`,
  ];
  for (const [status] of counts) {
    lines.push('', `## ${STATUS_TEXT[status]}`, '');
    for (const a of answers.filter((entry) => entry.status === status)) {
      lines.push(`### ${a.id}`, '', a.question ? `> ${a.question}` : '', '');
      if (a.folder) lines.push(`${a.rows} rows in \`${a.folder}/\` (data.csv, dataset.json, DATA.md).`, '');
      if (a.read) lines.push(`Read \`${a.read.table}\`:`, '', '```sql', a.read.sql, '```', '');
      for (const reason of a.reasons) lines.push(`- ${reason}`);
      for (const need of a.needs) lines.push(`- **${need.name}** (${need.level.replace('_', ' ')}): ${need.change}`);
      for (const note of a.notes) lines.push(`- Note: ${note}.`);
      if (a.reasons.length || a.needs.length || a.notes.length) lines.push('');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
