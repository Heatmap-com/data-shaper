import { applyRunLayer, parseRunRef, resolveStage } from '../domain/run-descriptor.js';
import { deepMerge, setPath } from '../domain/deep-merge.js';
import { DescriptorError } from '../domain/errors.js';
import { createHash } from 'node:crypto';

const MAX_CHAIN = 8;

/** @param {{descriptors: import('../ports/descriptor-source.js').DescriptorSourcePort}} deps */
export function createRunResolver({ descriptors }) {
  return { resolve, choose };

  async function choose(site, ref) {
    if (ref?.endsWith('.json')) return descriptors.runFile(ref);
    const { scope, name } = parseRunRef(ref ?? site.run ?? 'default');
    if (scope === 'general') return required(await descriptors.run('general', name), `general:${name}`);
    if (scope === 'site') return required(await descriptors.run('site', name, site.slug), `site:${name} for ${site.slug}`);
    return (await descriptors.run('site', name, site.slug)) ?? required(await descriptors.run('general', name), `general:${name}`);
  }

  async function resolve({ site, ref, sets = [] }) {
    const chain = [];
    let current = await choose(site, ref);
    while (current) {
      if (chain.some((layer) => layer.file === current.file)) throw new DescriptorError(`run extends cycle at ${current.file}`);
      if (chain.length === MAX_CHAIN) throw new DescriptorError(`run extends more than ${MAX_CHAIN} deep`);
      chain.unshift(current);
      current = current.body.extends ? await choose(site, current.body.extends) : null;
    }
    let run = { stages: [] };
    for (const layer of chain) run = applyRunLayer(run, layer.body, layer.file);
    run = withSiteStageParams(run, siteStageParams(site));
    for (const [dotted, value] of sets) run = setPath(run, dotted, value);

    const stages = [];
    for (const entry of run.stages.filter((stage) => stage.enabled)) {
      stages.push(resolveStage(await descriptors.stage(entry.use), entry));
    }
    const resolved = { id: run.id, description: run.description, defaults: run.defaults ?? {}, pages: run.pages ?? null, stages };
    const refs = chain.map((layer) => ({ ref: layer.body.id, file: layer.file }));
    return { run: resolved, refs, hash: createHash('sha256').update(JSON.stringify(resolved)).digest('hex') };
  }
}

/** The site's `profile` is the analysis stage's profile; its `stageParams` win over it. */
function siteStageParams(site) {
  if (!site.profile) return site.stageParams;
  return deepMerge({ analysis: { profile: site.profile } }, site.stageParams ?? {});
}

/**
 * The site's `stageParams` ({<stage id>: params}) over the params of the
 * run's stages of that id. A stage the run lacks takes nothing, so a site
 * that picks its analysis profile can still take a run without analysis.
 */
function withSiteStageParams(run, stageParams) {
  if (!stageParams || typeof stageParams !== 'object') return run;
  return {
    ...run,
    stages: run.stages.map((entry) => (Object.hasOwn(stageParams, entry.id)
      ? { ...entry, params: deepMerge(entry.params ?? {}, stageParams[entry.id]) }
      : entry)),
  };
}

function required(found, label) {
  if (!found) throw new DescriptorError(`no run descriptor ${label}`);
  return found;
}
