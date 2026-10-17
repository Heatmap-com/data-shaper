/** A ClickHouse single-quoted string literal. */
export function sqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** A column or alias name that is safe to place in generated SQL. */
export function sqlIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(String(name))) throw new Error(`not a SQL identifier: ${JSON.stringify(name)}`);
  return String(name);
}
