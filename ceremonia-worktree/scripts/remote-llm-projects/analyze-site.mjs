import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, USAGE } from './analyze-args.mjs';
import { renderPrompt } from './application/prompt.mjs';
import { saveReports, runAnalysis } from './application/run-analysis.mjs';
import { loadReportSpecs } from './application/report-specs.mjs';
import { collectSite } from './application/site-bundle.mjs';
import { uploadSite } from './application/upload-site.mjs';
import { loadProjectPort } from './load-port.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Create the project, upload the full bundle, the three reports, and the
 * style guide, then send the enhancement prompt. `--upload-only` stops
 * before the prompt.
 *
 * @param {string[]} argv
 * @param {{ loadProjectPort?: typeof loadProjectPort, fetch?: typeof fetch, env?: NodeJS.ProcessEnv, log?: (line: string) => void, sleep?: (ms: number) => Promise<void> }} [deps]
 */
export async function main(argv, deps = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.provider || !args.site) {
    console.error('provider and site are required');
    console.error(USAGE);
    return 2;
  }
  if (!SLUG.test(args.site)) {
    console.error(`site must be a slug, got ${JSON.stringify(args.site)}`);
    return 2;
  }

  const log = deps.log ?? ((line) => console.error(line));
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const dataDir = args.data ?? path.join(os.homedir(), 'work', 'analysis', args.site);
  const reportsDir = args.reports ?? path.join(repoRoot, 'docs', 'analysis', args.site);
  const styleGuide = args.styleGuide ?? path.join(repoRoot, 'docs', 'style-guide.md');
  const outDir = args.out ?? path.join(reportsDir, 'enhanced');

  try {
    const reports = await loadReportSpecs(args.stages ?? path.join(repoRoot, 'orchestration', 'stages'));
    const site = await collectSite({ slug: args.site, dataDir, reportsDir, styleGuide, reports });
    const template = await readFile(new URL('./prompts/enhance-reports.md', import.meta.url), 'utf8');
    const prompt = renderPrompt(template, site);
    const load = deps.loadProjectPort ?? loadProjectPort;
    const port = await load(args.provider, { ...deps, log });
    const uploaded = await uploadSite(port, { name: site.slug, files: site.files }, log);

    const summary = {
      provider: args.provider,
      site: site.slug,
      project: uploaded.project,
      uploaded: uploaded.uploaded,
    };

    if (args.uploadOnly) {
      console.log(JSON.stringify(summary, null, 2));
      return 0;
    }

    log('sending the analysis prompt');
    const result = await runAnalysis(port, uploaded.project.id, {
      prompt,
      title: `${site.brand} enhanced reports`,
      expectPaths: site.reports.map((report) => report.outputPath),
    });
    const written = await saveReports(outDir, result.files, result.text);
    const expected = new Set(site.reports.map((report) => report.name));
    const got = new Set(written.map((file) => path.basename(file)));
    const missing = [...expected].filter((name) => !got.has(name));
    summary.session = { id: result.id, stopReason: result.stopReason };
    summary.written = written;
    summary.missing = missing;
    console.log(JSON.stringify(summary, null, 2));
    if (missing.length) {
      log(`missing enhanced reports: ${missing.join(', ')}`);
      return 1;
    }
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
