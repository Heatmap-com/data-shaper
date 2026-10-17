import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createTail } from './tail.js';

/** Runs a command in its own process group so a timeout or abort kills every child. */
export function runProcess({ command, args = [], cwd, env, logFile, timeoutMs, killGraceMs = 10_000, signal, onLine, spawnFn = spawn }) {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logFile, { flags: 'a' });
    const tail = createTail(200);
    const started = Date.now();
    let timedOut = false;
    let aborted = false;
    let done = false;

    const child = spawnFn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const stop = () => { kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), killGraceMs).unref(); };
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, timeoutMs) : null;
    const onAbort = () => { aborted = true; stop(); };
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const pump = (stream) => {
      let carry = '';
      stream.on('data', (chunk) => {
        log.write(chunk);
        const lines = (carry + chunk.toString('utf8')).split('\n');
        carry = lines.pop();
        for (const line of lines) { tail.push(line); onLine?.(line); }
      });
      stream.on('end', () => { if (carry) { tail.push(carry); onLine?.(carry); } });
    };
    pump(child.stdout);
    pump(child.stderr);

    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      log.end(fn);
    };
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (exitCode, exitSignal) => finish(() => resolve({
      exitCode, exitSignal, timedOut, aborted, tail: tail.text(), durationMs: Date.now() - started,
    })));
  });
}
