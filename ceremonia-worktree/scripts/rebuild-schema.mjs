#!/usr/bin/env node
// The operator rebuild tool (data-capture-plan.md §8.3). Destructive work
// never happens in ensureSchema; this is the ONLY place DROP statements are
// issued, and only with --execute, only against the confirmed database, and
// only for allowlisted names.
//
//   node scripts/rebuild-schema.mjs --scope legacy|ae|all \
//     --confirm-database journey_events --backup <dir> [--execute]
//
// Without --execute every check runs and the full plan prints; nothing is
// written. With --execute the plan runs through the client and V1–V8 (§8.7)
// must pass. Scope `ae` creates schema 2 next to v1; scope `legacy` (step 10
// of the cutover) drops the 14 v1 objects.
//
// The plan is built in rebuild-schema/plan.mjs and run by
// rebuild-schema/execute.mjs; this file is the command line.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickHouseConfig, createClickHouse } from '../src/composition/clickhouse.js';
import { executeRebuildPlan, planFromCluster } from './rebuild-schema/execute.mjs';

export * from './rebuild-schema/plan.mjs';
export { executeRebuildPlan, planFromCluster } from './rebuild-schema/execute.mjs';

function printPlan(plan, scope) {
  const { classification } = plan;
  console.log(`scope: ${scope}`);
  console.log(`drop (${classification.drop.length}): ${classification.drop.join(', ') || '(none)'}`);
  console.log(`protected (${classification.protected.length}): ${classification.protected.join(', ') || '(none)'}`);
  console.log(`other (${classification.other.length}): ${classification.other.join(', ') || '(none)'}`);
  console.log(`protected snapshot: ${JSON.stringify(plan.protectedSnapshot)}`);
  console.log(`migrated legacy names: ${plan.migratedKeys}`);
  console.log(`seed counts: ${JSON.stringify(plan.seedCounts)}`);
  console.log(`\n${plan.statements.length} statement(s):`);
  plan.statements.forEach((s, i) => console.log(`  ${String(i + 1).padStart(3)}  ${s.split('\n')[0].slice(0, 140)}`));
  console.log('\nverification:');
  for (const group of plan.verification) {
    console.log(`  ${group.id} ${group.description}`);
    for (const check of group.checks) {
      const expect = check.expect ?? (check.expectAtLeast !== undefined ? `>= ${check.expectAtLeast}` : check.expectRefusal ?? 'side effect');
      console.log(`      ${check.sql.split('\n')[0].slice(0, 120)}  -> ${JSON.stringify(expect)}`);
    }
  }
}

async function gitSha() {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const scope = flag('scope');
  if (!scope || !['legacy', 'ae', 'all'].includes(scope)) {
    console.error('usage: node scripts/rebuild-schema.mjs --scope legacy|ae|all --confirm-database journey_events --backup <dir> [--execute]');
    process.exit(2);
  }
  const confirmDatabase = flag('confirm-database');
  const backupDir = flag('backup');
  const execute = args.includes('--execute');

  const { client, database, gateway } = createClickHouse(clickHouseConfig(process.env), { logger: { info() {} } });
  const plan = await planFromCluster({
    client,
    database,
    scope,
    confirmDatabase,
    backupDir,
    gitSha: await gitSha(),
  });

  if (!execute) {
    printPlan(plan, scope);
    console.log('\ndry run: no DDL issued. Re-run with --execute to apply.');
    return;
  }
  await executeRebuildPlan(plan, { client, gateway });
  console.log('V1–V8 passed.');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
