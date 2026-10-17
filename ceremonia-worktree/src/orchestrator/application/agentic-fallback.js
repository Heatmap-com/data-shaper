import path from 'node:path';
import { agentUnavailable, describeFailure } from '../domain/failure.js';
import { parseAgentReport } from '../domain/agent-report.js';

export function createAgenticFallback({ agents, prompts, checks, jobs, journal, governor, workspace, descriptors }) {
  return { recover };

  async function recover({ job, stage, unit, ctx, failure, verdict, rerun, verify }) {
    const spec = stage.fallback;
    if (!spec?.agent) return { type: 'failed', reason: `${stage.id}: ${verdict.reason}. No fallback is declared.` };
    const profiles = await descriptors.resilience();
    const profile = profiles[job.resilience];
    if (!profile) return { type: 'failed', reason: `${stage.id}: resilience "${job.resilience}" is not in general/resilience.json` };
    const limit = typeof spec.maxAttempts === 'object' ? (spec.maxAttempts[job.resilience] ?? profile.fallbackAttempts) : (spec.maxAttempts ?? profile.fallbackAttempts);
    const check = await checks.get(stage.check.use);
    let last = failure;
    let lastVerdict = verdict;

    for (;;) {
      const updated = await jobs.update(job.id, (draft) => { draft.stages[stage.id].fallbackAttempts += 1; });
      const n = updated.stages[stage.id].fallbackAttempts;
      if (n > limit) return { type: 'failed', reason: `${stage.id} on ${unit.key}: fallback used ${limit} attempt(s). Last: ${last.message}` };

      const runDir = await workspace.runDir(job.id, stage.id, `fallback-${n}`);
      const resultFile = path.join(runDir, 'result.json');
      const values = {
        ...ctx.values,
        failure: describeFailure(last, lastVerdict),
        check: { description: check.describe(ctx, stage.check) },
        resilience: { level: job.resilience, repairScope: profile.repairScope },
        run: { dir: runDir, resultFile, attempt: n, limit },
      };
      const prompt = await prompts.render(spec.prompt, values, { site: job.site.slug });
      const agent = await agents.get(spec.agent);
      await journal.record(job, { type: 'fallback.started', stage: stage.id, message: `${unit.key}: ${agent.id} fallback ${n}/${limit} (${prompt.sources.join(' + ')}).` });

      let result;
      try {
        result = await governor.withResources(spec.resources ?? stage.resources ?? [], ctx.owner, ctx.signal, () => agent.run({
          prompt: prompt.text,
          runDir,
          workdir: ctx.paths.repo,
          addDirs: [runDir, ...(spec.addDirs ?? []).map(ctx.render)],
          skillsDirs: spec.skillsDirs?.map(ctx.render),
          model: spec.model ?? null,
          timeoutMs: spec.timeoutMs,
          signal: ctx.signal,
        }));
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
        await journal.record(job, { type: 'fallback.finished', stage: stage.id, message: `${agent.id} could not start: ${err.message}` });
        return { type: 'blocked', reason: `${stage.id} on ${unit.key}: ${agent.id} could not start (${err.message}). Install it or fix its command in the agent descriptor.` };
      }
      const finalText = String(result.finalText ?? '');
      const report = await readReport(workspace, resultFile);
      if (!report.written && agentUnavailable(result)) {
        const detail = finalText.replace(/\s+/g, ' ').slice(0, 240);
        await journal.record(job, { type: 'fallback.finished', stage: stage.id, message: `${agent.id} is unavailable (usage limit): ${detail}`, data: { transcript: result.transcriptFile } });
        return { type: 'blocked', reason: `${stage.id} on ${unit.key}: ${agent.id} is unavailable (usage limit). ${detail}`.trim() };
      }
      await journal.record(job, { type: 'fallback.finished', stage: stage.id, message: `${agent.id} exited ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}, reported ${report.status}: ${report.summary}`, data: { transcript: result.transcriptFile, changes: report.changes } });

      if (report.status === 'blocked') return { type: 'blocked', reason: `${stage.id} on ${unit.key}: ${report.blocker || report.summary}` };

      let after = await verify();
      if (!after.ok && spec.rerunPrimary) {
        const again = await rerun();
        after = again ? { ok: false, summary: again.message, details: again.details ?? [] } : { ok: true, summary: 'complete after rerun', details: [] };
      }
      if (after.ok) {
        await jobs.update(job.id, (draft) => { draft.stages[stage.id].recoveredBy = agent.id; });
        return { type: 'recovered', agent: agent.id, summary: report.summary };
      }
      last = { kind: 'agent', message: `after fallback ${n}, the check still fails: ${after.summary}`, details: after.details, logTail: finalText.slice(-4000) };
      lastVerdict = { class: 'defect', reason: 'fallback did not complete the stage' };
    }
  }
}

/** @param {import('../ports/workspace.js').WorkspacePort} workspace @param {string} file */
async function readReport(workspace, file) {
  return parseAgentReport(await workspace.readJson(file));
}
