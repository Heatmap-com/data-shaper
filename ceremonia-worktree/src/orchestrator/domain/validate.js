import { capacityProblem } from './capacity.js';
import { chartProblems } from './charts.js';

/**
 * Checks a job's resolved run against the library: adapter ids, agent
 * descriptors, prompt files, pages, resilience, error rules, resources,
 * declared charts, and required template values. Every problem is collected and returned; nothing
 * here throws for a validation problem, only for a programmer error.
 *
 * @param {{descriptors: import('../ports/descriptor-source.js').DescriptorSourcePort,
 *          prompts: import('../ports/prompt-source.js').PromptSourcePort,
 *          handlers: {get: (id: string) => unknown},
 *          checks: {get: (id: string) => unknown},
 *          capacity?: Record<string, import('./capacity.js').CapacityEntry>,
 *          values?: Record<string, unknown>}} deps values is the config's values block, for {{config.*}} references
 */
export function createValidator({ descriptors, prompts, handlers, checks, capacity, values = {} }) {
  if (typeof handlers?.get !== 'function') throw new TypeError('validator needs handlers.get');
  if (typeof checks?.get !== 'function') throw new TypeError('validator needs checks.get');

  return { validateJob };

  /** @param {import('../ports/job-store.js').Job} job @returns {Promise<string[]>} */
  async function validateJob(job) {
    const problems = [];
    const site = job.site?.slug;
    let profiles = null;
    try {
      profiles = await descriptors.resilience();
    } catch (err) {
      problems.push(err.message);
    }
    if (profiles && !profiles[job.resilience]) {
      problems.push(`resilience "${job.resilience}" is not in general/resilience.json (${Object.keys(profiles).join(', ')})`);
    }
    problems.push(...chartProblems(job.run));
    for (const stage of job.run?.stages ?? []) {
      if (!stage.handler?.use) problems.push(`stage ${stage.id}: no handler`);
      if (!stage.check?.use) problems.push(`stage ${stage.id}: no completion check`);
      for (const [index, rule] of (stage.errors ?? []).entries()) {
        if (!CLASSES.has(rule?.class)) problems.push(`stage ${stage.id}: errors[${index}] class "${rule?.class}" is not one of ${[...CLASSES].join(', ')}`);
        try {
          new RegExp(rule?.match, 'i');
        } catch (err) {
          problems.push(`stage ${stage.id}: errors[${index}] match is not a valid regex: ${err.message}`);
        }
      }
      if (capacity) {
        for (const name of new Set([...(stage.resources ?? []), ...(stage.fallback?.resources ?? [])])) {
          const problem = capacityProblem(capacity[name]);
          if (problem) problems.push(`stage ${stage.id}: resource "${name}" ${problem} in the config's governor.capacity`);
        }
      }
      if (stage.handler?.use) {
        try {
          const found = await handlers.get(stage.handler.use);
          if (!found) problems.push(`stage ${stage.id}: unknown handler "${stage.handler.use}"`);
        } catch {
          problems.push(`stage ${stage.id}: unknown handler "${stage.handler.use}"`);
        }
      }
      if (stage.check?.use) {
        let found = null;
        try {
          found = await checks.get(stage.check.use);
        } catch {
          found = null;
        }
        if (!found) problems.push(`stage ${stage.id}: unknown check "${stage.check.use}"`);
        else if (typeof found.validate === 'function') {
          for (const problem of found.validate(stage.check)) problems.push(`stage ${stage.id}: check ${stage.check.use}: ${problem}`);
        }
      }
      if (stage.handler?.agent) {
        if (!stage.handler.prompt) problems.push(`stage ${stage.id}: the agent handler has no prompt`);
        try {
          await descriptors.agent(stage.handler.agent);
        } catch {
          problems.push(`stage ${stage.id}: agent "${stage.handler.agent}" has no descriptor`);
        }
      }
      if (stage.fallback?.agent) {
        if (!stage.skill) problems.push(`stage ${stage.id}: a fallback needs the stage's skill, which its prompt hands to the agent`);
        if (!stage.fallback.prompt) problems.push(`stage ${stage.id}: fallback has no prompt`);
        try {
          await descriptors.agent(stage.fallback.agent);
        } catch {
          problems.push(`stage ${stage.id}: fallback agent "${stage.fallback.agent}" has no descriptor`);
        }
      }
      for (const prompt of [stage.handler?.prompt ?? stage.prompt, stage.fallback?.prompt]) {
        if (!prompt) continue;
        try {
          await prompts.sources(prompt, { site });
        } catch {
          problems.push(`stage ${stage.id}: prompt "${prompt}" does not resolve for ${site ?? 'general'}`);
        }
      }
      if (stage.forEach === 'pages' && (job.pages ?? []).length === 0) {
        problems.push(`stage ${stage.id}: forEach "pages" but the job has no pages`);
      }
      for (const ref of unresolvedRefs(templateStrings(stage), { site: job.site ?? {}, config: values })) {
        const owner = ref.startsWith('site.') ? `${site ?? 'the site'} has no ${ref.slice(5)}` : `the config has no values.${ref.slice(7)}`;
        problems.push(`stage ${stage.id}: templates reference {{${ref}}} but ${owner}`);
      }
    }
    return problems;
  }
}

const CLASSES = new Set(['transient', 'blocked', 'defect']);

const REF = /\{\{\s*((?:site|config)(?:\.[A-Za-z0-9_-]+)+)\s*\}\}/g;

/** {{site.*}} and {{config.*}} references that resolve to nothing. Other roots are filled per attempt. */
function unresolvedRefs(texts, roots) {
  const refs = new Set(texts.flatMap((text) => [...text.matchAll(REF)].map((match) => match[1])));
  return [...refs].filter((ref) => ref.split('.').reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), roots) === undefined);
}

/** Every string in the handler spec, the check spec, and the fallback addDirs. */
function templateStrings(stage) {
  const { use: _handlerUse, prompt: _handlerPrompt, ...handlerSpec } = stage.handler ?? {};
  const { use: _checkUse, ...checkSpec } = stage.check ?? {};
  const { addDirs } = stage.fallback ?? {};
  return [handlerSpec, checkSpec, addDirs].flatMap(collect);
}

function collect(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collect);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(collect);
  return [];
}
