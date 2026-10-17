import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describeReport, evaluateReport, parseMarkdown, REPORT_RULES } from '../../../domain/report-check/index.js';

/**
 * A finished markdown report, judged against the full bundle it was written
 * from. Spec: { use: 'markdown-report', file, bundle, rules: { ... } }, where
 * the rules are the ones in src/domain/report-check/rules.js.
 *
 * @type {import('../../ports/completion-check.js').CompletionCheck}
 */
export const adapter = {
  id: 'markdown-report',
  validate(spec) {
    const problems = ['file', 'bundle'].filter((key) => typeof spec[key] !== 'string' || !spec[key]).map((key) => `needs ${key}`);
    const unknown = Object.keys(spec.rules ?? {}).filter((name) => !REPORT_RULES[name]);
    if (unknown.length) problems.push(`unknown rule ${unknown.join(', ')}; use ${Object.keys(REPORT_RULES).join(', ')}`);
    return problems;
  },
  describe(ctx, spec) {
    const file = ctx.render(spec.file);
    return [`${file} exists, written from the full bundle at ${ctx.render(spec.bundle)}, with:`, ...describeReport(spec.rules ?? {}).map((line) => `- ${line}`)].join('\n');
  },
  async evaluate(ctx, spec) {
    const file = ctx.render(spec.file);
    const bundle = ctx.render(spec.bundle);
    const text = await readFile(file, 'utf8').catch((err) => ({ error: err.code ?? err.message }));
    if (typeof text !== 'string') return fail(file, `report ${text.error}`);
    const profileFile = path.join(bundle, '00_site_profile.json');
    const profile = await readFile(profileFile, 'utf8').then(JSON.parse).catch(() => null);
    if (!profile) return fail(profileFile, 'no bundle profile; reports are written from the full bundle');

    const doc = parseMarkdown(text);
    const dir = path.dirname(file);
    const figures = {};
    for (const ref of doc.images) figures[ref] = await isFile(path.resolve(dir, ref));
    const facts = {
      figures,
      anchors: Array.isArray(profile.anchors) ? profile.anchors : [],
      window: profile.report_window ?? {},
      docTime: await mtime(file),
      bundleTime: await mtime(profileFile),
    };
    const details = evaluateReport(doc, spec.rules ?? {}, facts);
    const failed = details.filter((row) => !row.ok);
    return {
      ok: failed.length === 0,
      summary: failed.length === 0 ? `${path.basename(file)}: ${details.length} check(s) pass` : `${path.basename(file)}: ${failed.map((row) => row.name).join('; ')}`,
      details,
    };
  },
};

function fail(name, message) {
  return { ok: false, summary: `${path.basename(name)}: ${message}`, details: [{ name, ok: false, message }] };
}

async function isFile(file) {
  return stat(file).then((info) => info.isFile(), () => false);
}

async function mtime(file) {
  return stat(file).then((info) => info.mtimeMs, () => null);
}
