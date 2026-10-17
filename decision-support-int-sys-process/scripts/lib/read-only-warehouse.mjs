/**
 * The warehouse as the live acceptance scripts see it: every read goes
 * through a client that refuses writes and system tables, and the gateway
 * counts each label's calls, rows, and seconds.
 */

const READ = /^(SELECT|WITH|DESCRIBE|DESC|EXISTS|EXPLAIN)\b/i;
const LEADING = /^(\s+|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/;

/**
 * Inserts, commands, and any statement other than a read throw before they
 * reach the server.
 * @param {object} raw
 */
export function readOnlyClient(raw) {
  const refuse = (what) => {
    throw new Error(`read-only client refused ${what}`);
  };
  return {
    async query(args) {
      const sql = String(args.query ?? '');
      const head = sql.replace(LEADING, '');
      if (!READ.test(head)) refuse(`"${head.slice(0, 40)}"`);
      if (/\bsystem\./i.test(sql)) refuse('a system table read');
      return raw.query(args);
    },
    insert: async () => refuse('an insert'),
    command: async () => refuse('a command'),
    exec: async () => refuse('an exec'),
    close: async () => raw.close(),
  };
}

/**
 * The read-only client, plus inserts into one table: the day store's
 * `ae_scan_day`. Every other write still throws.
 * @param {object} raw
 * @param {string} table `<database>.ae_scan_day`
 */
export function dayStoreClient(raw, table) {
  const reads = readOnlyClient(raw);
  return {
    ...reads,
    async insert(args) {
      if (args.table !== table) throw new Error(`day store client refused an insert into ${args.table}`);
      return raw.insert(args);
    },
  };
}

export async function rowsOf(client, query, params = {}) {
  const res = await client.query({ query, query_params: params, format: 'JSONEachRow' });
  return res.json();
}

const TABLE_PROBE = /FROM\s+system\.tables\s+WHERE\s+database\s*=\s*'(\w+)'\s+AND\s+table\s*=\s*'(\w+)'/;

/**
 * The production gateway over the read-only client, with the two
 * system-table reads answered by DESCRIBE and EXISTS. Every label's calls,
 * rows, and seconds are counted, and `calls` lists each call in order.
 */
export function acceptanceGateway(base, client) {
  /** @type {Map<string, {calls: number, rows: number, maxRows: number, seconds: number}>} */
  const labels = new Map();
  /** @type {Array<{label: string, params: object, rows: number, seconds: number}>} */
  const calls = [];
  const columns = new Map();
  const note = (label, params, rows, started) => {
    const seconds = (Date.now() - started) / 1000;
    const cell = labels.get(label) ?? { calls: 0, rows: 0, maxRows: 0, seconds: 0 };
    cell.calls += 1;
    cell.rows += rows;
    cell.maxRows = Math.max(cell.maxRows, rows);
    cell.seconds += seconds;
    labels.set(label, cell);
    calls.push({ label, params, rows, seconds });
  };
  return {
    labels,
    calls,
    async query(sql, params = {}, label = 'query') {
      const started = Date.now();
      const probe = TABLE_PROBE.exec(sql);
      const rows = probe
        ? [{ n: Number((await rowsOf(client, `EXISTS TABLE ${probe[1]}.${probe[2]}`))[0]?.result ?? 0) }]
        : await base.query(sql, params, label);
      note(label, params, rows.length, started);
      return rows;
    },
    explain: (sql, params, label) => base.explain(sql, params, label),
    columns(table) {
      if (!/^\w+$/.test(table)) throw new Error(`columns: unexpected table name ${table}`);
      if (!columns.has(table)) {
        columns.set(table, rowsOf(client, `DESCRIBE TABLE default.${table}`)
          .then((rows) => rows.map((row) => ({ name: row.name, type: row.type }))));
      }
      return columns.get(table);
    },
  };
}
