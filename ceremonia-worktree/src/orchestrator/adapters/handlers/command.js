import path from 'node:path';
import { runProcess } from '../_lib/process.js';

/** @type {import('../../ports/stage-handler.js').StageHandler} */
export const adapter = {
  id: 'command',
  async run(ctx, spec) {
    const command = resolveCommand(ctx.render(spec.command), ctx.paths.repo);
    const args = (spec.args ?? []).map((arg) => ctx.render(arg));
    const cwd = spec.cwd ? ctx.render(spec.cwd) : ctx.paths.repo;
    const logFile = path.join(ctx.runDir, 'primary.log');
    const shown = [command, ...args].join(' ');
    const result = await runProcess({
      command, args, cwd, logFile,
      env: ctx.env(renderEnv(spec.env, ctx.render)),
      timeoutMs: spec.timeoutMs ?? ctx.stage.timeoutMs,
      signal: ctx.signal,
    });
    const ok = result.exitCode === 0 && !result.timedOut && !result.aborted;
    return {
      status: ok ? 'ok' : 'error',
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      command: shown,
      logFile,
      logTail: result.tail,
      message: ok ? 'exit 0' : result.timedOut ? `timed out after ${spec.timeoutMs ?? ctx.stage.timeoutMs}ms` : `exit ${result.exitCode ?? result.exitSignal}`,
    };
  },
};

/** `bin/x.sh` is repo-relative; a bare name such as `node` or `python3` is found on PATH. */
export function resolveCommand(command, repo) {
  if (path.isAbsolute(command) || !command.includes('/')) return command;
  return path.join(repo, command);
}

function renderEnv(env, render) {
  if (!env || typeof env !== 'object') return env;
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, typeof value === 'string' ? render(value) : value]));
}
