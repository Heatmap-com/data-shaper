#!/usr/bin/env node
// Regenerates src/persistence/schema2.sql from the data-capture plan's
// section 8.4/8.5 DDL. The plan is the source of truth; this script exists
// so the SQL stays traceable instead of hand-maintained.
//   node scripts/build-schema2.mjs ~/Work/research2/output/data-capture-plan.md
// Conventions applied on top of the extracted DDL:
//   - line comments are stripped before splitting (the plan's comments
//     contain semicolons);
//   - a table partitioned by toYYYYMM(x) also carries x in its ORDER BY
//     (the plan's own rule that some §8.4 blocks drifted from; x is
//     functionally dependent on the row key, so no granularity changes).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const planPath = process.argv[2];
if (!planPath) throw new Error('usage: build-schema2.mjs <data-capture-plan.md>');
const md = readFileSync(planPath, 'utf8');

const blocks = [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
const ddlBlocks = blocks.filter((b) => b.includes('CREATE TABLE IF NOT EXISTS journey_events.ae_'));

let statements = [];
for (const block of ddlBlocks) {
  const stripped = block
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  statements.push(...stripped.split(';').map((s) => s.trim()).filter((s) => s.startsWith('CREATE TABLE')));
}

// Partition convention: partition column joins ORDER BY when absent.
statements = statements.map((stmt) => {
  const partition = stmt.match(/PARTITION BY toYYYYMM\((\w+)\)/);
  if (!partition) return stmt;
  const column = partition[1];
  const orderMatch = stmt.match(/ORDER BY \(([^)]*)\)/);
  if (!orderMatch) return stmt;
  const keys = orderMatch[1].split(',').map((k) => k.trim());
  if (keys.includes(column)) return stmt;
  keys.push(column);
  return stmt.replace(/ORDER BY \([^)]*\)/, `ORDER BY (${keys.join(', ')})`);
});

let sql = statements.map((s) => s.replace(/journey_events\./g, '${DATABASE}.')).join(';\n\n') + ';\n\n';

const names = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS \$\{DATABASE\}\.(ae_\w+)/g)].map((m) => m[1]);
const appendOnly = new Set(['ae_schema_version', 'ae_ingest_run']);
for (const name of names) {
  if (appendOnly.has(name)) continue;
  sql += `CREATE OR REPLACE VIEW IF NOT EXISTS \${DATABASE}.${name}_current AS\nSELECT * FROM \${DATABASE}.${name} FINAL;\n\n`;
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'persistence', 'schema2.sql');
writeFileSync(out, sql);
console.log(`tables: ${names.length}, views: ${names.filter((n) => !appendOnly.has(n)).length}`);
