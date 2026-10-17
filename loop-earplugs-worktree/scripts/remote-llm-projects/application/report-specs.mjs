import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The client reports, read from the orchestrator's report stage descriptors:
 * every `*.stage.json` with a `report` block. A report's file is
 * `{Brand} — {title}.md`, as the stage's completion check expects.
 *
 * @param {string} stagesDir orchestration/stages
 * @returns {Promise<Array<{ role: string, job: string, pattern: RegExp }>>}
 */
export async function loadReportSpecs(stagesDir) {
  const names = (await readdir(stagesDir)).filter((name) => name.endsWith('.stage.json')).sort();
  const specs = [];
  for (const name of names) {
    const stage = JSON.parse(await readFile(path.join(stagesDir, name), 'utf8'));
    if (!stage.report?.title) continue;
    specs.push({ order: stage.report.order ?? Number.MAX_SAFE_INTEGER, role: stage.report.title, job: stage.report.job ?? stage.label ?? stage.report.title, pattern: reportPattern(stage.report.title) });
  }
  if (!specs.length) throw new Error(`no report stages (a "report" block) in ${stagesDir}`);
  return specs.sort((a, b) => a.order - b.order).map(({ order: _order, ...spec }) => spec);
}

/** ` — Site Opportunity Report.md` at the end of a file name. */
export function reportPattern(title) {
  return new RegExp(` — ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.md$`);
}
