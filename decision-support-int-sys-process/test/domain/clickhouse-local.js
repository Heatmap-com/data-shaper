import { execFileSync } from 'node:child_process';

/** True when the `clickhouse` binary can run `clickhouse local`. */
export function hasClickHouseLocal() {
  try {
    execFileSync('clickhouse', ['local', '--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `query` over `rows` (read from stdin as table `t` with `structure`) and
 * returns the result rows.
 *
 * @param {string} structure e.g. "u String"
 * @param {object[]} rows
 * @param {string} query
 * @param {Record<string, string>} [params] bound as {name:Type} query parameters
 */
export function runLocal(structure, rows, query, params = {}) {
  const out = execFileSync('clickhouse', [
    'local', ...Object.entries(params).map(([name, value]) => `--param_${name}=${value}`),
    '--input-format', 'JSONEachRow', '--structure', structure,
    '--output-format', 'JSONEachRow', '--query', query.replaceAll('{table}', 'table'),
  ], { input: rows.map((row) => JSON.stringify(row)).join('\n'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
