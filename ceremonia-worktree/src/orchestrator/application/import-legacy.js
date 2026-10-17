import { LEGACY_OPEN, LEGACY_RUNS, legacyToJob } from '../domain/legacy-queue.js';
import { messageFor, queueName, windowFor } from '../domain/job.js';
import { resolvePages } from '../domain/pages.js';
import { normalizeDomain } from '../domain/site.js';

/**
 * Brings every legacy queue item into the job store under its legacy id, so
 * a second import finds each one and skips it. Open items resume on their
 * first unfinished stage once the run validates for the site. The legacy
 * file is only read.
 */
export function createLegacyImport({ siteResolver, registry, resolver, validator, jobs, queue, journal }) {
  return async function importLegacy({ source, dryRun = false }) {
    const items = [...await source.items()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const imported = [];
    const skipped = [];
    const problems = [];

    for (const item of items) {
      const label = `${item.id} (${item.domain})`;
      if (await jobs.get(item.id)) {
        skipped.push({ id: item.id, domain: item.domain, reason: 'already imported' });
        continue;
      }
      try {
        const domain = normalizeDomain(item.domain);
        const { site, found } = await siteResolver(domain, { lookup: LEGACY_OPEN.has(item.status) });
        const ref = LEGACY_RUNS[item.process];
        if (!ref) {
          problems.push(`${label}: legacy process "${item.process}" has no run`);
          continue;
        }
        const resolved = await resolver.resolve({ site, ref });
        const { job, resume, notes } = legacyToJob({
          item,
          site,
          resolved,
          pages: resolvePages({ runPages: resolved.run.pages, site }),
          window: windowFor(resolved.run.defaults.window, new Date(item.created_at)),
        });
        if (!job) {
          problems.push(...notes.map((note) => `${label}: ${note}`));
          continue;
        }
        if (resume) {
          const open = await jobs.findOpenByDomain(site.domain);
          if (open.length) {
            skipped.push({ id: item.id, domain: item.domain, reason: `${site.domain} already has open job ${open[0].id}` });
            continue;
          }
          const invalid = await validator.validateJob(job);
          if (invalid.length) {
            problems.push(`${label}: run ${resolved.run.id} is not valid for ${site.slug}: ${invalid.join('; ')}`);
            continue;
          }
        }
        if (!dryRun) {
          if (found) await registry.register(site);
          await jobs.create(job);
          if (resume) await queue.enqueue(queueName(resume.id), messageFor(job, resume));
          const done = resolved.run.stages.filter((stage) => job.stages[stage.id].status === 'done').map((stage) => stage.id);
          await journal.record(job, {
            type: 'job.imported',
            message: `imported from ${source.location} (legacy ${item.status}) as run ${resolved.run.id}. Done: ${done.join(', ') || 'none'}.`
              + `${resume ? ` Resumes at ${resume.id}.` : ''}${notes.length ? ` ${notes.join('. ')}.` : ''}`,
          });
        }
        imported.push({ id: job.id, domain: site.domain, slug: site.slug, status: job.status, resume: resume?.id ?? null, notes });
      } catch (err) {
        problems.push(`${label}: ${err.message}`);
      }
    }

    const verb = dryRun ? 'Would import' : 'Imported';
    const message = `${verb} ${imported.length} of ${items.length} legacy item${items.length === 1 ? '' : 's'} from ${source.location}.`
      + `${skipped.length ? ` Skipped ${skipped.length}.` : ''}${problems.length ? ` ${problems.length} problem(s).` : ''}`;
    return { dryRun, message, imported, skipped, problems };
  };
}
