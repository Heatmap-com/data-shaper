import path from 'node:path';
import { renderValues } from '../domain/template.js';

/**
 * Builds the StageContext one unit of one stage delivery runs against.
 * Config paths arrive already expanded by loadConfig. Reports default to
 * docs/analysis in the repository.
 */
export function createContexts({ repoRoot, config, workspace, descriptors, env = {} }) {
  return { create };

  async function create({ job, stage, unit, attempt, owner, signal }) {
    const runDir = await workspace.runDir(job.id, stage.id, `attempt-${attempt}`);
    const profiles = descriptors ? await descriptors.resilience() : {};
    const values = {
      site: job.site,
      job: { id: job.id, priority: job.priority, resilience: job.resilience },
      stage: { id: stage.id, label: stage.label, skill: stage.skill, also: stage.also, params: stage.params ?? {}, report: stage.report ?? {} },
      unit,
      params: stage.params ?? {},
      window: job.window,
      config: config.values ?? {},
      paths: {
        repo: repoRoot,
        analysis: config.values?.analysisRoot ?? '',
        reports: config.values?.reportsRoot ?? path.join(repoRoot, 'docs', 'analysis'),
      },
      resilience: { level: job.resilience, repairScope: profiles[job.resilience]?.repairScope ?? '' },
      run: { dir: runDir, attempt },
    };
    return {
      job,
      stage,
      unit,
      attempt,
      owner,
      signal,
      runDir,
      values,
      paths: values.paths,
      render: (text) => renderValues(text, values, `stage ${stage.id}`),
      env: (extra) => ({ ...env, ...(stage.env ?? {}), ...(extra ?? {}) }),
    };
  }
}
