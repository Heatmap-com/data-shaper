import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildShape, readSources } from '../shaping/build.js';
import { answerMarkdown, dataMarkdown, datasetTable, toCsv } from '../shaping/output.js';
import { planRequest } from '../shaping/plan.js';
import { answerQualitySection, qualityLedger, qualityMarkdown, summaryOf } from '../quality/output.js';
import { exclusionsForBuild, screenPlan, subjectCache } from '../quality/screen.js';
import { requestQualitySpec } from '../quality/site-files.js';
import { valueOf } from './args.js';

const USAGE = '--shape <requests.json> (--plan | --out <dir>) [--no-quality]';

/**
 * Answers a set of dataset requests: a file holding one request, or
 * `{ "requests": [...] }` as an agent writes them from a transcript. Each
 * request is planned, its sources are read and checked, and, unless
 * `--plan`, it is built and written to `<out>/<id>/` as data.csv,
 * dataset.json, and DATA.md. `<out>/ANSWER.md` and `<out>/answer.json` say,
 * for every request, what was built, what reads stored rows, what is
 * blocked and why, and what needs a person. Before a build, the data-quality
 * screens run over the site's sessions in the query window; the build drops
 * what their dispositions exclude, and `<out>/<id>/QUALITY.md` and
 * `quality.json` say what was found, what was applied, and what waits for a
 * person (`--quality-decide` records the answer). `--no-quality` builds
 * without screening. Reads the warehouse; writes no table. Blocked,
 * needs-a-person, and findings awaiting a decision are answers, so they exit
 * 0; an invalid request or a failed check exits 1, and a usage error 2.
 */
export const shape = {
  flag: 'shape',
  usage: USAGE,
  async run(flags, ctx) {
    const file = valueOf(flags, 'shape');
    const planOnly = flags.plan !== undefined;
    const out = valueOf(flags, 'out');
    if (!file || (!planOnly && !out)) {
      return { ok: false, errors: [`--shape needs a requests file and --plan or --out <dir>`, `usage: node src/cli.js ${USAGE}`], exitCode: 2 };
    }
    let requests;
    try {
      const doc = JSON.parse(await readFile(file, 'utf8'));
      requests = Array.isArray(doc?.requests) ? doc.requests : [doc];
    } catch (err) {
      return { ok: false, errors: [`${file}: ${message(err)}`], exitCode: 1 };
    }

    const today = ctx.clock.todayUtc();
    const shaping = await ctx.shaping();
    let columns = null;
    const deps = {
      segmentations: await ctx.segmentations(),
      shaping,
      today,
      database: ctx.database,
      async visitColumns() {
        columns ??= ctx.gateway().columns('udp_hsrce_visits').then((rows) => new Set(rows.map((row) => row.name)));
        return columns;
      },
      trendRange: (idsite) => ctx.persistence().readTrendWeekRange(idsite, 'all'),
    };
    const quality = flags['no-quality'] !== undefined || planOnly ? null : { registry: await ctx.quality(), cache: subjectCache() };

    const answers = [];
    const seen = new Set();
    for (const doc of requests) {
      let answer = await planRequest(doc, deps);
      if (seen.has(answer.id)) answer = { ...answer, status: 'invalid', level: null, reasons: [`id ${answer.id} is used by an earlier request in the set`], plan: undefined };
      seen.add(answer.id);
      if (answer.status === 'ready') answer = await carryOut(answer, { ctx, shaping, planOnly, out, today, quality, visitColumns: deps.visitColumns });
      answers.push(answer);
    }

    if (out) {
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, 'ANSWER.md'), `${answerMarkdown(answers, { today, from: path.basename(file) })}${answerQualitySection(answers)}`);
      await writeFile(path.join(out, 'answer.json'), `${JSON.stringify(answers.map(publicAnswer), null, 2)}\n`);
    }
    const output = summary(answers, out);
    const broken = answers.filter((a) => a.status === 'invalid' || a.status === 'failed');
    return broken.length > 0
      ? { ok: false, output, errors: broken.map((a) => `${a.id}: ${a.status}: ${a.reasons.join('; ')}`), exitCode: 1 }
      : { ok: true, output };
  },
};

/**
 * Reads the sources of a ready request and, unless planning, screens it,
 * builds it with the exclusions the screens' dispositions apply, and writes it.
 */
async function carryOut(answer, { ctx, shaping, planOnly, out, today, quality, visitColumns }) {
  const sources = await readSources(answer.plan, shaping);
  const notes = [...answer.notes, ...sources.notes];
  if (sources.reasons.length > 0) return { ...answer, status: 'blocked', level: null, reasons: sources.reasons, notes };
  if (planOnly) return { ...answer, notes };
  const gateway = ctx.gateway();
  let screened = null;
  if (quality) {
    let request;
    try {
      request = requestQualitySpec(answer.plan.request.quality, `${answer.id}: quality`);
    } catch (err) {
      return { ...answer, status: 'invalid', level: null, reasons: [message(err)], notes };
    }
    const run = await screenPlan(answer.plan, { registry: quality.registry, gateway, attributes: shaping.forSite(answer.plan.idsite).attributes, visitColumns, cache: quality.cache, request });
    if (run.status === 'invalid') return { ...answer, status: 'invalid', level: null, reasons: run.reasons, notes };
    screened = run.result;
  }
  const applied = screened ? exclusionsForBuild(answer.plan, screened.exclusions) : null;
  const built = await buildShape(applied?.plan ?? answer.plan, sources, { gateway, kinds: shaping.kinds, ...(applied ? { quality: { sql: applied.sql, params: applied.params } } : {}) });
  if (built.status !== 'built') return { ...answer, status: built.status, level: null, reasons: built.reasons, notes };
  const done = { ...answer, notes };
  const table = datasetTable(answer.plan, built);
  const folder = path.join(out, answer.plan.id);
  await mkdir(folder, { recursive: true });
  let qualityAnswer;
  let qualityLines;
  if (screened) {
    const ledger = path.join(folder, 'quality.json');
    const slug = quality.registry.slugOf(answer.plan.idsite) ?? answer.plan.slug ?? null;
    await writeFile(ledger, `${JSON.stringify(qualityLedger(screened, { dataset: answer.plan.id, idsite: answer.plan.idsite, slug, today }), null, 2)}\n`);
    await writeFile(path.join(folder, 'QUALITY.md'), qualityMarkdown(screened, { dataset: answer.plan.id, idsite: answer.plan.idsite, today, ledger }));
    const waiting = screened.findings.filter((f) => f.status === 'awaiting_decision').map((f) => ({ id: f.id, question: f.question }));
    qualityAnswer = { summary: summaryOf(screened), waiting, folder: answer.plan.id };
    qualityLines = qualityDataLines(qualityAnswer.summary, waiting);
  }
  await writeFile(path.join(folder, 'data.csv'), toCsv(table));
  await writeFile(path.join(folder, 'DATA.md'), dataMarkdown(done, table, built, sources, { today, kinds: shaping.kinds, ...(qualityLines ? { quality: qualityLines } : {}) }));
  await writeFile(path.join(folder, 'dataset.json'), `${JSON.stringify({
    id: answer.plan.id,
    question: answer.plan.request.question,
    idsite: answer.plan.idsite,
    built: today,
    window: answer.plan.window,
    period: answer.plan.period,
    columns: table.columns,
    rows: table.rows,
    segmentations: answer.plan.segmentations.map((seg) => ({ id: seg.id, label: seg.label, values: seg.values, data: seg.descriptor.data })),
    sources: sources.read,
    checks: built.checks,
    notes,
    ...(qualityAnswer ? { quality: qualityAnswer.summary } : {}),
    request: answer.plan.request,
  }, null, 2)}\n`);
  return { ...done, status: 'built', folder: answer.plan.id, rows: table.rows.length, ...(qualityAnswer ? { quality: qualityAnswer } : {}) };
}

/** The data-quality lines of DATA.md: what the numbers leave out, and what still waits. */
function qualityDataLines(summary, waiting) {
  const lines = [];
  const out = [
    summary.excludedOrders > 0 ? `${summary.excludedOrders} orders` : null,
    summary.excludedVisits > 0 ? `${summary.excludedVisits} sessions by visit` : null,
    ...summary.excludedGroups.map((text) => `every session with ${text}`),
  ].filter(Boolean);
  lines.push(out.length > 0 ? `Every number here leaves out ${out.join('; ')}. QUALITY.md says why and who decided.` : 'Nothing is excluded: every kept session and order counts.');
  lines.push(`${summary.findings} findings: ${summary.awaiting} waiting for a person, ${summary.auto} applied without one, ${summary.decided} decided.`);
  if (waiting.length > 0) lines.push('', 'Waiting for a person, with the build applying each screen\'s pending disposition until then:', '', ...waiting.map((q) => `- \`${q.id}\`: ${q.question}`));
  return lines;
}

/** An answer without its plan's resolved internals, with the request it answered. */
function publicAnswer({ plan, ...rest }) {
  return plan ? { ...rest, request: plan.request } : rest;
}

function summary(answers, out) {
  const lines = answers.map((a) => {
    const detail = a.status === 'built' ? `${a.rows} rows in ${path.join(out, a.folder)}${a.quality ? `; quality: ${a.quality.summary.findings} findings, ${a.quality.summary.awaiting} waiting for you` : ''}`
      : a.status === 'read' ? `read ${a.read.table}`
        : a.status === 'ready' ? `${a.plan.groups.length} queries over ${a.plan.queryWindow.start} to ${a.plan.queryWindow.end}`
          : a.needs.length > 0 ? a.needs.map((need) => `${need.name} (${need.level.replace('_', ' ')})`).join('; ')
            : a.reasons.join('; ');
    return `${a.id}: ${a.status.replace('_', ' ')}: ${detail}`;
  });
  if (out) lines.push(`answer: ${path.join(out, 'ANSWER.md')}`);
  return lines.join('\n');
}

const message = (err) => (err instanceof Error ? err.message : String(err));
