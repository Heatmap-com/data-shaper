import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdapter as createAgentHandler } from '../../src/orchestrator/adapters/handlers/agent.js';
import { adapter as chartRender } from '../../src/orchestrator/adapters/handlers/chart-render.js';
import { resolveCommand } from '../../src/orchestrator/adapters/handlers/command.js';
import { adapter as chartsRendered } from '../../src/orchestrator/adapters/checks/charts-rendered.js';
import { adapter as filesExist } from '../../src/orchestrator/adapters/checks/files-exist.js';
import { adapter as markdownReport } from '../../src/orchestrator/adapters/checks/markdown-report.js';
import { createLayeredPromptSource } from '../../src/orchestrator/adapters/prompts/layered-fs.js';
import { createWorkspace } from '../../src/orchestrator/adapters/workspace/fs.js';
import { createRegistry } from '../../src/orchestrator/composition/plugins.js';
import { chartProblems, declaredCharts } from '../../src/orchestrator/domain/charts.js';
import { classifyFailure } from '../../src/orchestrator/domain/failure.js';

const REPO = path.resolve(import.meta.dirname, '../..');
const ORCHESTRATION = path.join(REPO, 'orchestration');

let root;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'report-stages-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const render = (values) => (text) => text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => String(key.split('.').reduce((node, part) => node?.[part], values)));

function context({ run = { stages: [] }, values = {}, runDir = path.join(root, 'run') } = {}) {
  const all = { site: { slug: 'acme', name: 'Acme' }, paths: { repo: root, analysis: path.join(root, 'analysis'), reports: path.join(root, 'reports') }, run: { dir: runDir, attempt: 1 }, ...values };
  return {
    job: { id: 'j1', site: all.site, run },
    stage: { id: 'site-opportunity-report', check: { use: 'files-exist', paths: ['{{paths.reports}}/done.md'] }, timeoutMs: 1000 },
    runDir,
    values: all,
    paths: all.paths,
    render: render(all),
    env: (extra) => ({ ...(extra ?? {}) }),
    signal: new AbortController().signal,
  };
}

function agentHandler(behave) {
  const requests = [];
  const agent = {
    id: 'fake',
    async run(request) {
      requests.push(request);
      return { exitCode: 0, timedOut: false, aborted: false, finalText: 'done', transcriptFile: path.join(request.runDir, 't.jsonl'), ...(await behave(request)) };
    },
  };
  const handler = createAgentHandler({
    agents: { get: async () => agent },
    prompts: { render: async (name, values) => ({ text: `${name} ${values.check.description} ${values.run.resultFile}`, sources: [name] }) },
    checks: { get: async () => filesExist },
    workspace: createWorkspace({ root: path.join(root, 'runs') }),
  });
  return { handler, requests };
}

describe('agent handler', () => {
  beforeEach(async () => mkdir(path.join(root, 'run'), { recursive: true }));
  const spec = { use: 'agent', agent: 'fake', prompt: 'report/x.md', addDirs: ['{{paths.analysis}}/{{site.slug}}'] };
  const result = (body) => async (request) => {
    await writeFile(path.join(request.runDir, 'result.json'), JSON.stringify(body));
  };

  it('renders the prompt with the check and the result file, and returns ok on fixed', async () => {
    const { handler, requests } = agentHandler(result({ status: 'fixed', summary: 'wrote it' }));
    const out = await handler.run(context(), spec);
    expect(out.status).toBe('ok');
    expect(requests[0].prompt).toContain(`these files exist: ${path.join(root, 'reports')}/done.md`);
    expect(requests[0].prompt).toContain(path.join(root, 'run', 'result.json'));
    expect(requests[0].addDirs).toEqual([path.join(root, 'run'), path.join(root, 'analysis', 'acme')]);
    expect(requests[0].workdir).toBe(root);
  });

  it('hands a blocked report to the classifier as a verdict', async () => {
    const { handler } = agentHandler(result({ status: 'blocked', blocker: 'login wall' }));
    const out = await handler.run(context(), spec);
    expect(out).toMatchObject({ status: 'error', message: 'blocked: login wall', verdict: { class: 'blocked', reason: 'login wall' } });
    expect(classifyFailure([], { message: out.message, hint: out.verdict })).toEqual({ class: 'blocked', reason: 'login wall' });
  });

  it('reads a usage limit with no result file as blocked', async () => {
    const { handler } = agentHandler(async () => ({ exitCode: 1, finalText: 'You have reached your monthly usage limit. Your quota will be refreshed on 1 November.' }));
    const out = await handler.run(context(), spec);
    expect(out.verdict).toEqual({ class: 'blocked', reason: 'fake is unavailable (usage limit)' });
  });

  it('fails a run that exits non-zero or gives up', async () => {
    const exited = await agentHandler(async () => ({ exitCode: 2 })).handler.run(context(), spec);
    expect(exited.status).toBe('error');
    expect(exited.verdict).toBeUndefined();
    const gaveUp = await agentHandler(result({ status: 'gave_up', summary: 'no data' })).handler.run(context(), spec);
    expect(gaveUp.status).toBe('error');
  });

  it('blocks when the agent binary cannot start', async () => {
    const { handler } = agentHandler(async () => {
      throw Object.assign(new Error('spawn kimi ENOENT'), { code: 'ENOENT' });
    });
    const out = await handler.run(context(), spec);
    expect(out.verdict.class).toBe('blocked');
    expect(out.message).toMatch(/could not start/);
  });
});

describe('failure hints', () => {
  it('lets a stage error rule win over the handler hint, and the hint win over the default', () => {
    const rules = [{ match: 'ECONNRESET', class: 'transient', reason: 'network' }];
    expect(classifyFailure(rules, { message: 'ECONNRESET', hint: { class: 'blocked', reason: 'x' } })).toEqual({ class: 'transient', reason: 'network' });
    expect(classifyFailure(rules, { message: 'odd', hint: { class: 'blocked' } })).toEqual({ class: 'blocked', reason: 'odd' });
    expect(classifyFailure(rules, { message: 'odd' }).class).toBe('defect');
  });
});

describe('handler registry', () => {
  it('builds createAdapter modules with the registry deps and caches them', async () => {
    const registry = createRegistry('handlers', { agents: {}, prompts: {}, checks: {}, workspace: {} });
    const agent = await registry.get('agent');
    expect(agent.id).toBe('agent');
    expect(await registry.get('agent')).toBe(agent);
    expect((await registry.get('command')).id).toBe('command');
  });
});

describe('command resolution', () => {
  it('finds bare names on PATH and repo paths under the repo', () => {
    expect(resolveCommand('node', '/repo')).toBe('node');
    expect(resolveCommand('bin/seed.sh', '/repo')).toBe('/repo/bin/seed.sh');
    expect(resolveCommand('/usr/bin/python3', '/repo')).toBe('/usr/bin/python3');
  });
});

describe('declared charts', () => {
  const run = {
    stages: [
      { id: 'a', charts: { 'sor-fig1-daily-orders': { type: 'daily-orders' }, 'sor-fig9-gone': null } },
      { id: 'b' },
      { id: 'c', charts: { 'uj-fig1-weekly-revenue': { type: 'weekly-revenue', title: 'T' } } },
    ],
  };

  it('lists each chart once, in stage order, with its file and stage', () => {
    expect(declaredCharts(run)).toEqual([
      { type: 'daily-orders', file: 'sor-fig1-daily-orders.png', stage: 'a' },
      { type: 'weekly-revenue', title: 'T', file: 'uj-fig1-weekly-revenue.png', stage: 'c' },
    ]);
  });

  it('reports a bad stem, a missing type, a duplicate, and a non-object', () => {
    expect(chartProblems(run)).toEqual([]);
    expect(chartProblems({
      stages: [
        { id: 'a', charts: { 'Fig 1': { type: 'x' }, 'fig-2': {} } },
        { id: 'b', charts: { 'fig-2': { type: 'x' } } },
        { id: 'c', charts: [] },
      ],
    })).toEqual([
      'stage a: chart "Fig 1" needs a lower-case file stem such as sor-fig1-daily-orders',
      'stage a: chart "fig-2" needs a type',
      'stage b: chart "fig-2" is also declared by stage a',
      'stage c: charts must be an object of file stem to chart spec',
    ]);
  });
});

describe('chart-render handler', () => {
  const run = { stages: [{ id: 'sor', charts: { 'sor-fig1-daily-orders': { type: 'daily-orders' } } }] };

  it('writes the declared specs and runs the command with --specs', async () => {
    const ctx = context({ run });
    await mkdir(ctx.runDir, { recursive: true });
    const script = path.join(root, 'render.mjs');
    await writeFile(script, "import { copyFileSync } from 'node:fs';\nconst at = process.argv.indexOf('--specs');\ncopyFileSync(process.argv[at + 1], `${process.argv[at + 1]}.seen`);\n");
    const out = await chartRender.run(ctx, { command: process.execPath, args: [script, '--bundle', '{{paths.analysis}}/{{site.slug}}'] });
    expect(out.status, out.logTail).toBe('ok');
    const seen = JSON.parse(await readFile(path.join(ctx.runDir, 'charts.json.seen'), 'utf8'));
    expect(seen.charts).toEqual([{ type: 'daily-orders', file: 'sor-fig1-daily-orders.png', stage: 'sor' }]);
  });

  it('succeeds without running anything when the run declares no charts', async () => {
    const out = await chartRender.run(context(), { command: '/nonexistent' });
    expect(out).toEqual({ status: 'ok', message: 'this run declares no charts' });
  });
});

describe('charts-rendered check', () => {
  const run = { stages: [{ id: 'sor', charts: { 'fig-a': { type: 'x' }, 'fig-b': { type: 'y' } } }] };
  const spec = { use: 'charts-rendered', media: '{{paths.reports}}/acme/media', bundle: '{{paths.analysis}}/acme' };
  const media = () => path.join(root, 'reports', 'acme', 'media');

  async function bundle(time = new Date('2026-10-13T00:00:00Z')) {
    const dir = path.join(root, 'analysis', 'acme');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '00_site_profile.json'), '{}');
    await utimes(path.join(dir, '00_site_profile.json'), time, time);
  }

  async function manifest(charts) {
    await mkdir(media(), { recursive: true });
    await writeFile(path.join(media(), 'charts.json'), JSON.stringify({ charts }));
  }

  it('passes when each chart is drawn or skipped with a reason', async () => {
    await bundle();
    await manifest([{ file: 'fig-a.png', status: 'rendered' }, { file: 'fig-b.png', status: 'skipped', reason: 'the bundle has no scroll table' }]);
    await writeFile(path.join(media(), 'fig-a.png'), 'png');
    const out = await chartsRendered.evaluate(context({ run }), spec);
    expect(out).toMatchObject({ ok: true, summary: '1 chart(s) drawn, 1 skipped' });
  });

  it('fails a missing file, an unlisted chart, and a skip with no reason', async () => {
    await bundle();
    await manifest([{ file: 'fig-a.png', status: 'rendered' }]);
    const missing = await chartsRendered.evaluate(context({ run }), spec);
    expect(missing.ok).toBe(false);
    expect(missing.summary).toBe('charts not drawn: fig-a.png (missing), fig-b.png (not in the manifest)');
    await manifest([{ file: 'fig-a.png', status: 'skipped' }, { file: 'fig-b.png', status: 'skipped', reason: 'r' }]);
    expect((await chartsRendered.evaluate(context({ run }), spec)).summary).toMatch(/skipped without a reason/);
  });

  it('fails charts older than the bundle, and a run with no bundle', async () => {
    const none = await chartsRendered.evaluate(context({ run }), spec);
    expect(none.summary).toMatch(/no bundle profile/);
    await manifest([{ file: 'fig-a.png', status: 'rendered' }, { file: 'fig-b.png', status: 'skipped', reason: 'r' }]);
    await bundle(new Date(Date.now() + 60_000));
    expect((await chartsRendered.evaluate(context({ run }), spec)).summary).toMatch(/older than the bundle profile/);
  });

  it('names its required spec keys', () => {
    expect(chartsRendered.validate({ use: 'charts-rendered' })).toEqual(['needs media', 'needs bundle']);
  });
});

describe('files-exist newerThan', () => {
  it('counts an output older than its input as stale', async () => {
    const input = path.join(root, 'in.md');
    const output = path.join(root, 'out.pdf');
    await writeFile(output, 'pdf');
    await writeFile(input, 'md');
    await utimes(output, new Date('2026-01-01'), new Date('2026-01-01'));
    const spec = { paths: [output], newerThan: [input, path.join(root, 'absent.md')] };
    const stale = await filesExist.evaluate(context(), spec);
    expect(stale).toMatchObject({ ok: false, summary: `missing, too small, or stale: ${output}` });
    expect(stale.details[0].message).toBe(`older than ${input}`);
    await utimes(output, new Date(), new Date(Date.now() + 60_000));
    expect((await filesExist.evaluate(context(), spec)).ok).toBe(true);
    expect(filesExist.describe(context(), spec)).toMatch(/each newer than/);
  });
});

describe('markdown-report check', () => {
  const spec = {
    use: 'markdown-report',
    file: '{{paths.reports}}/acme/Acme — Report.md',
    bundle: '{{paths.analysis}}/acme',
    rules: { sections: ['At a glance'], figures: true, anchors: ['orders in report window'], windowEnd: true, fresh: true },
  };
  const profile = { report_window: { start: '2026-09-13', end: '2026-10-12' }, anchors: [{ label: 'orders in report window', expect: 201 }] };

  async function write(markdown, { figure = true } = {}) {
    await mkdir(path.join(root, 'analysis', 'acme'), { recursive: true });
    await writeFile(path.join(root, 'analysis', 'acme', '00_site_profile.json'), JSON.stringify(profile));
    await utimes(path.join(root, 'analysis', 'acme', '00_site_profile.json'), new Date('2026-10-13'), new Date('2026-10-13'));
    await mkdir(path.join(root, 'reports', 'acme', 'media'), { recursive: true });
    if (figure) await writeFile(path.join(root, 'reports', 'acme', 'media', 'a.png'), 'png');
    await writeFile(path.join(root, 'reports', 'acme', 'Acme — Report.md'), markdown);
  }

  it('passes a report that quotes the anchors and links figures that exist', async () => {
    await write('# Acme\n\n## At a glance\n\n201 orders through 12 October 2026.\n\n![a](media/a.png)\n');
    const out = await markdownReport.evaluate(context(), spec);
    expect(out.ok, out.summary).toBe(true);
  });

  it('names the failing rules in its summary', async () => {
    await write('# Acme\n\n200 orders.\n\n![a](media/a.png)\n', { figure: false });
    const out = await markdownReport.evaluate(context(), spec);
    expect(out.summary).toBe('Acme — Report.md: section "At a glance"; figure media/a.png; anchor "orders in report window"; window end');
  });

  it('fails without the report or the full bundle', async () => {
    expect((await markdownReport.evaluate(context(), spec)).summary).toMatch(/report ENOENT/);
    await mkdir(path.join(root, 'reports', 'acme'), { recursive: true });
    await writeFile(path.join(root, 'reports', 'acme', 'Acme — Report.md'), '# x');
    expect((await markdownReport.evaluate(context(), spec)).summary).toMatch(/no bundle profile/);
  });

  it('describes done for the prompt, and validates its spec', () => {
    expect(markdownReport.describe(context(), spec)).toBe([
      `${root}/reports/acme/Acme — Report.md exists, written from the full bundle at ${root}/analysis/acme, with:`,
      '- these sections, in headings: At a glance',
      '- every linked figure exists beside the report',
      "- quotes the bundle's anchor numbers: orders in report window",
      "- names the last day of the bundle's report window",
      '- written after the bundle it reads was built',
    ].join('\n'));
    expect(markdownReport.validate({ use: 'markdown-report', rules: { minWords: 1, speling: true } })).toEqual([
      'needs file', 'needs bundle', expect.stringMatching(/^unknown rule speling; use minWords/),
    ]);
  });
});

describe('report prompts', () => {
  const prompts = createLayeredPromptSource({ root: ORCHESTRATION });
  const values = (site) => ({
    site,
    stage: { id: 'site-opportunity-report', label: 'Site Opportunity Report', skill: 'skills/site-opportunity-report/SKILL.md', report: { title: 'Site Opportunity Report', job: 'the month' } },
    paths: { repo: REPO, analysis: '/data', reports: '/reports' },
    run: { dir: '/run', attempt: 1, resultFile: '/run/result.json' },
    resilience: { level: 'standard', repairScope: 'this stage only' },
    check: { description: 'the report passes' },
  });

  it('renders each report prompt with every value filled, and Sayii gets its site notes', async () => {
    const sayii = { slug: 'sayii', name: 'Sayii', domain: 'sayiioficial.com', currency: 'USD' };
    for (const name of ['report/site-opportunity-report.md', 'report/today-opportunities.md', 'report/user-journey.md']) {
      const out = await prompts.render(name, values(sayii), { site: 'sayii' });
      expect(out.text).not.toMatch(/\{\{/);
      expect(out.text).toContain('/data/sayii');
      expect(out.text).toContain('/reports/sayii/media/charts.json');
      expect(out.text).toContain('the report passes');
      expect(out.text).toContain('carrito');
      expect(out.sources).toContain(path.join(ORCHESTRATION, 'sites', 'sayii', 'prompts', 'report', 'site-notes.md'));
    }
    const general = await prompts.render('report/site-opportunity-report.md', values({ slug: 'acme', name: 'Acme', domain: 'acme.test', currency: 'EUR' }), { site: 'acme' });
    expect(general.text).toContain('/reports/acme/Acme — Site Opportunity Report.md');
    expect(general.text).not.toContain('carrito');
  });

  it('lists partials, with their site layers, among a prompt\'s sources', async () => {
    const files = await prompts.sources('report/user-journey.md', { site: 'sayii' });
    expect(files.map((file) => path.relative(ORCHESTRATION, file))).toEqual([
      'general/prompts/report/user-journey.md',
      'general/prompts/system/agent-rules.md',
      'general/prompts/report/inputs.md',
      'general/prompts/report/site-notes.md',
      'sites/sayii/prompts/report/site-notes.md',
      'general/prompts/system/result-contract.md',
    ]);
  });
});
