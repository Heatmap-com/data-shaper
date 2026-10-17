import { readFile } from 'node:fs/promises';
import { resolveSegmentationVersions } from '../../domain/segmentation/index.js';
import { segmentationCheckSql } from '../../enrichment/trend-sql.js';
import { addDays, mondayOf } from '../../triggers/time.js';
import { siteSegmentationSpec } from '../segmentation/site-spec.js';
import { ok, oneSite } from './args.js';

const USAGE = '--segmentation-check --sites <idsite> --week YYYY-MM-DD (--segmentation <id> | --segmentation-file <path>)';
const MAX_SHARE = 0.98;
const SETTINGS = `
SETTINGS max_execution_time = 180,
         timeout_before_checking_execution_speed = 0`;

/**
 * Checks a segmentation on one site's week before it is committed: one
 * query per segmentation over the kept sessions of the week starting on
 * the Monday given, then the sessions, orders, revenue, and share of each
 * value, the partition against `all`, and the version the definition would
 * get. Writes nothing. Exit 0 when every check passes; 1 on a validation
 * error, a partition mismatch, or one value over 98% of sessions; 2 on a
 * usage error.
 */
export const segmentationCheck = {
  flag: 'segmentation-check',
  usage: USAGE,
  async run(flags, ctx) {
    let args;
    try {
      args = checkArgs(flags);
    } catch (err) {
      return { ok: false, errors: [message(err), `usage: node src/cli.js ${USAGE}`], exitCode: 2 };
    }
    let checked;
    try {
      checked = await candidates(args, ctx);
    } catch (err) {
      return { ok: false, errors: [message(err)], exitCode: 1 };
    }
    const recorded = await recordedOf(ctx, args.idsite);
    const gateway = ctx.gateway();
    const params = { idsite: args.idsite, w0: args.week, w1: addDays(args.week, 6) };
    const lines = [`idsite ${args.idsite}, week of ${args.week} (${params.w0} to ${params.w1})`];
    const problems = [];
    for (const seg of checked) {
      if (seg.kind !== 'declared') {
        problems.push(`${seg.id}: computed; check it with a trend run, not --segmentation-check`);
        continue;
      }
      const rows = await gateway.query(`${segmentationCheckSql(seg)}${SETTINGS}`, params, 'trend:segmentation-check');
      const report = reportOf(seg, rows, recorded);
      lines.push('', ...report.lines);
      problems.push(...report.problems);
    }
    const output = lines.join('\n');
    return problems.length > 0 ? { ok: false, output, errors: problems, exitCode: 1 } : ok(output);
  },
};

function checkArgs(flags) {
  const idsite = oneSite(flags, 'segmentation-check');
  const week = flags.week;
  if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new Error('--segmentation-check needs --week YYYY-MM-DD');
  if (mondayOf(week) !== week) throw new Error(`--week ${week} is not a Monday; weeks start Monday (${mondayOf(week)})`);
  const id = flags.segmentation;
  const file = flags['segmentation-file'];
  if ((id === undefined) === (file === undefined)) throw new Error('--segmentation-check takes one of --segmentation <id> or --segmentation-file <path>');
  if (id === 'true' || file === 'true') throw new Error(`--${id === 'true' ? 'segmentation' : 'segmentation-file'} needs a value`);
  return { idsite, week, id, file };
}

/**
 * The segmentations to check: the one named, or every one a file touches.
 * A whole site file is checked as the loader and the registry check it; one
 * declaration is checked as the site's new declaration.
 */
async function candidates(args, ctx) {
  if (args.id) {
    const site = (await ctx.segmentations()).forSite(args.idsite);
    const seg = site.get(args.id);
    if (!seg) throw new Error(`idsite ${args.idsite}: unknown segmentation "${args.id}" (${[...site.keys()].sort().join(', ')})`);
    return [seg];
  }
  let doc;
  try {
    doc = JSON.parse(await readFile(args.file, 'utf8'));
  } catch (err) {
    throw new Error(`${args.file}: ${message(err)}`);
  }
  const wholeFile = doc && typeof doc === 'object' && !Array.isArray(doc) && 'idsite' in doc;
  let spec;
  if (wholeFile) {
    spec = siteSegmentationSpec(doc, 'check', args.file);
    if (spec.idsite !== args.idsite) throw new Error(`${args.file}: idsite ${spec.idsite} is not --sites ${args.idsite}`);
  } else {
    const stored = (await ctx.registries.segmentations()).find((row) => row.idsite === args.idsite);
    spec = {
      slug: stored?.slug ?? 'check',
      idsite: args.idsite,
      defaults: stored?.defaults ?? {},
      overrides: stored?.overrides ?? {},
      declarations: [...(stored?.declarations ?? []).filter((row) => row.id !== doc?.id), doc],
    };
  }
  const site = (await ctx.segmentationsWith(spec)).forSite(args.idsite);
  const ids = [...new Set([...Object.keys(spec.overrides), ...spec.declarations.map((row) => row.id)])];
  if (ids.length === 0) throw new Error(`${args.file}: declares and overrides nothing`);
  return ids.map((id) => site.get(id));
}

async function recordedOf(ctx, idsite) {
  try {
    const persistence = ctx.persistence();
    return typeof persistence?.readSegmentationDefinitions === 'function' ? await persistence.readSegmentationDefinitions(idsite) : null;
  } catch {
    return null;
  }
}

/**
 * @param {import('../../ports/segmentation.js').Segmentation} seg
 * @param {object[]} rows the check query rows
 * @param {object[] | null} recorded the stored definitions, when readable
 */
function reportOf(seg, rows, recorded) {
  const problems = [];
  const all = rows.find((row) => row.segment === 'all');
  const total = Number(all?.sessions ?? 0);
  const byValue = new Map(rows.filter((row) => row.segment === seg.id).map((row) => [String(row.segment_value), row]));
  const values = [...seg.values, ...[...byValue.keys()].filter((value) => !seg.values.includes(value))];
  const width = Math.max(5, ...values.map((value) => value.length));
  const lines = [`${seg.id}: ${versionText(seg, recorded)}`, `  ${'value'.padEnd(width)}  sessions   share  orders   revenue`];
  let sum = 0;
  for (const value of values) {
    const row = byValue.get(value);
    const sessions = Number(row?.sessions ?? 0);
    sum += sessions;
    const share = total > 0 ? sessions / total : 0;
    lines.push(`  ${value.padEnd(width)}  ${String(sessions).padStart(8)}  ${`${(share * 100).toFixed(1)}%`.padStart(6)}  ${String(Number(row?.orders ?? 0)).padStart(6)}  ${Number(row?.revenue ?? 0).toFixed(2).padStart(8)}`);
    if (total > 0 && share > MAX_SHARE) problems.push(`${seg.id}: ${value} holds ${(share * 100).toFixed(1)}% of sessions; a rule is wrong or the site tags differently`);
    if (!seg.values.includes(value)) problems.push(`${seg.id}: the query returned ${value}, which is not one of its values`);
  }
  lines.push(`  partition: ${sum} of ${total} sessions`);
  if (total === 0) problems.push(`${seg.id}: no kept sessions in the week`);
  else if (sum !== total) problems.push(`${seg.id}: values hold ${sum} sessions, all holds ${total}`);
  return { lines, problems };
}

function versionText(seg, recorded) {
  if (!recorded) return 'stored versions unreadable';
  const [resolved] = resolveSegmentationVersions([{ id: seg.id, stamp: seg.stamp({}) }], recorded);
  if (resolved.changed) return `version ${resolved.version} would replace stored version ${resolved.previous}`;
  if (resolved.isNew) return 'version 1, nothing stored';
  return `matches stored version ${resolved.version}`;
}

const message = (err) => (err instanceof Error ? err.message : String(err));
