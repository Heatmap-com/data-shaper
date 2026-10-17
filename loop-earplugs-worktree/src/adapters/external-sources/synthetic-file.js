import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isIsoDay } from '../../domain/shaping/dates.js';

/**
 * A simulated connector: a kind's rows are `<dir>/<kind>.jsonl`, one JSON
 * object per line, and `<dir>/<kind>.coverage.json` ({ start, end }) says
 * which days the file vouches for. Without a coverage file, a facts file
 * vouches for the days from its first row to its last. A facts read keeps
 * the rows inside the range, as an API call for those days would, and every
 * row whose date is not a day, so the build reports it.
 */
export const adapter = {
  id: 'synthetic-file',
  /** @param {import('../../ports/external-source.js').FetchRequest} request */
  async fetch({ kind, options, range }) {
    const dir = options.dir;
    if (typeof dir !== 'string' || !dir) throw new Error(`synthetic-file: the ${kind.id} connection needs a dir`);
    const file = path.join(dir, `${kind.id}.jsonl`);
    const text = await readFile(file, 'utf8');
    const rows = text.split('\n').map((line) => line.trim()).filter(Boolean).map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`${file}:${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    if (kind.role !== 'facts') return { rows, coverage: null };
    const dates = rows.map((row) => row.date).filter(isIsoDay).sort();
    const coverage = await readCoverage(path.join(dir, `${kind.id}.coverage.json`)) ?? (dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null);
    const inRange = range ? rows.filter((row) => !isIsoDay(row.date) || (row.date >= range.start && row.date <= range.end)) : rows;
    return { rows: inRange, coverage };
  },
};

async function readCoverage(file) {
  try {
    const doc = JSON.parse(await readFile(file, 'utf8'));
    return { start: String(doc.start), end: String(doc.end) };
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
