import path from 'node:path';
import { parseAgentReport } from '../../domain/agent-report.js';
import { agentUnavailable } from '../../domain/failure.js';

/**
 * A coding agent as the stage's primary worker: render the stage prompt, run
 * the agent, and read its result.json. The stage's completion check, run by
 * the executor afterwards, decides whether the work is done.
 *
 * Spec: { use: 'agent', agent, prompt, timeoutMs?, model?, addDirs?, skillsDirs? }
 *
 * @param {{agents: {get: (id: string) => Promise<import('../../ports/coding-agent.js').CodingAgentPort>},
 *          prompts: import('../../ports/prompt-source.js').PromptSourcePort,
 *          checks: {get: (id: string) => Promise<import('../../ports/completion-check.js').CompletionCheck>},
 *          workspace: import('../../ports/workspace.js').WorkspacePort}} deps
 * @returns {import('../../ports/stage-handler.js').StageHandler}
 */
export function createAdapter({ agents, prompts, checks, workspace }) {
  return {
    id: 'agent',
    async run(ctx, spec) {
      const check = await checks.get(ctx.stage.check.use);
      const resultFile = path.join(ctx.runDir, 'result.json');
      const values = {
        ...ctx.values,
        check: { description: check.describe(ctx, ctx.stage.check) },
        run: { ...ctx.values.run, dir: ctx.runDir, resultFile },
      };
      const prompt = await prompts.render(spec.prompt, values, { site: ctx.job.site.slug });
      const agent = await agents.get(spec.agent);
      const command = `${agent.id} ${spec.prompt} (${prompt.sources.join(' + ')})`;

      let result;
      try {
        result = await agent.run({
          prompt: prompt.text,
          runDir: ctx.runDir,
          workdir: ctx.paths.repo,
          addDirs: [ctx.runDir, ...(spec.addDirs ?? []).map(ctx.render)],
          skillsDirs: spec.skillsDirs?.map(ctx.render),
          model: spec.model ?? null,
          timeoutMs: spec.timeoutMs ?? ctx.stage.timeoutMs,
          signal: ctx.signal,
        });
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
        const message = `${agent.id} could not start (${err.message}). Install it or fix its command in the agent descriptor.`;
        return { status: 'error', message, command, verdict: { class: 'blocked', reason: message } };
      }

      const finalText = String(result.finalText ?? '');
      const report = parseAgentReport(await workspace.readJson(resultFile));
      const base = { exitCode: result.exitCode, timedOut: result.timedOut, command, logFile: result.transcriptFile, logTail: finalText.slice(-4000) };
      if (!report.written && agentUnavailable(result)) {
        const message = `${agent.id} is unavailable (usage limit): ${finalText.replace(/\s+/g, ' ').slice(0, 240)}`.trim();
        return { ...base, status: 'error', message, verdict: { class: 'blocked', reason: `${agent.id} is unavailable (usage limit)` } };
      }
      if (report.status === 'blocked') {
        const reason = report.blocker || report.summary || 'the agent reported a blocker';
        return { ...base, status: 'error', message: `blocked: ${reason}`, verdict: { class: 'blocked', reason } };
      }
      if (result.timedOut) return { ...base, status: 'error', message: `${agent.id} timed out after ${spec.timeoutMs ?? ctx.stage.timeoutMs}ms` };
      if (result.aborted) return { ...base, status: 'error', message: `${agent.id} was stopped` };
      if (result.exitCode !== 0) return { ...base, status: 'error', message: `${agent.id} exited ${result.exitCode}` };
      if (report.status !== 'fixed') return { ...base, status: 'error', message: `${agent.id} ${report.written ? `reported ${report.status}: ${report.summary}` : 'wrote no result.json'}` };
      return { ...base, status: 'ok', message: report.summary };
    },
  };
}
