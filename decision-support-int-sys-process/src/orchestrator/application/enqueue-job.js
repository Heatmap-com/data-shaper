import { assertPriority, createJob, messageFor, queueName, windowFor } from '../domain/job.js';
import { resolvePages } from '../domain/pages.js';
import { OrchestratorError } from '../domain/errors.js';

/**
 * A site with no `site.json` is looked up in the site directory; once its
 * run validates, its `site.json` is written so later runs and overrides
 * start from it.
 */
export function createEnqueue({ siteResolver, registry, resolver, validator, jobs, queue, journal, clock, newId }) {
  return async function enqueue({ site: selector, run: ref, priority, resilience, pages: cliPages, sets, note }) {
    if (priority !== undefined) assertPriority(priority);
    const { site, found } = await siteResolver(selector);
    const open = await jobs.findOpenByDomain(site.domain);
    if (open.length) throw new OrchestratorError(`${site.domain} already has open job ${open[0].id}`, { exitCode: 2 });

    const resolved = await resolver.resolve({ site, ref, sets });
    const now = clock.now();
    const job = createJob({
      id: newId(now, site.slug),
      site,
      pages: resolvePages({ cliPages, runPages: resolved.run.pages, site }),
      window: windowFor(resolved.run.defaults.window, now),
      priority: assertPriority(priority ?? resolved.run.defaults.priority ?? 'normal'),
      resilience: resilience ?? resolved.run.defaults.resilience ?? 'standard',
      resolved,
      now,
    });
    const problems = await validator.validateJob(job);
    if (problems.length) throw new OrchestratorError(`run ${resolved.run.id} is not valid for ${site.slug}:\n- ${problems.join('\n- ')}`);

    const registered = found ? await registry.register(site) : null;
    const first = job.run.stages[0];
    job.stages[first.id].status = 'queued';
    await jobs.create(job);
    await queue.enqueue(queueName(first.id), messageFor(job, first));
    const origin = registered ? ` Site found in default.sites (idsite ${site.idsite}, ${site.name}); wrote ${registered}.` : '';
    await journal.record(job, {
      type: 'job.queued',
      message: `queued. Run ${resolved.run.id} (${resolved.refs.map((entry) => entry.file).join(' → ')}), ${job.priority} priority, ${job.resilience} resilience, ${job.pages.length} page(s), window ${job.window.start} to ${job.window.end}.${origin}${note ? ` ${note}` : ''}`,
    });
    return job;
  };
}
