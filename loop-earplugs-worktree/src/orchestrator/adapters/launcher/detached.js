import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';

/**
 * Spawns `cli.js run --until-idle` detached, with output in
 * `<logDir>/worker-<stamp>-<pid>.log`. The worker exits once its stage
 * queues are empty.
 *
 * @param {{cli: string, configFile: string, logDir: string, cwd: string, clock: {now: () => Date}, env: object}} options
 * @returns {import('../../ports/worker-launcher.js').WorkerLauncherPort}
 */
export function createDetachedLauncher({ cli, configFile, logDir, cwd, clock, env }) {
  return {
    async launch({ stages } = {}) {
      mkdirSync(logDir, { recursive: true });
      const stamp = clock.now().toISOString().replace(/[:.]/g, '-');
      const pending = path.join(logDir, `worker-${stamp}.log`);
      const fd = openSync(pending, 'a');
      const args = ['--disable-warning=ExperimentalWarning', cli, 'run', '--until-idle', '--config', configFile];
      if (stages?.length) args.push('--stages', stages.join(','));
      try {
        const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
        child.unref();
        return { pid: child.pid, log: pending };
      } finally {
        closeSync(fd);
      }
    },
  };
}
