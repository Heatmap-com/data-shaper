import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../_lib/process.js';

/**
 * Kimi Code CLI, one prompt per process: `kimi -p ... --output-format stream-json`.
 * Prompt mode is already non-interactive, so `mode` is informational only and
 * no --auto/--yolo flag is emitted (kimi 2.x rejects them with -p).
 * The full prompt is written to prompt.md and the CLI is told to read it, so a
 * long failure log never hits the argv limit.
 *
 * @param {object} descriptor contents of orchestration/agents/<id>.agent.json
 * @param {{ env?: NodeJS.ProcessEnv, run?: typeof runProcess }} [deps]
 * @returns {import('../../ports/coding-agent.js').CodingAgentPort}
 */
export function createAgent(descriptor, deps = {}) {
  const env = deps.env ?? {};
  const run = deps.run ?? runProcess;

  return {
    id: descriptor.id,
    async run(request) {
      const promptFile = path.join(request.runDir, 'prompt.md');
      const transcriptFile = path.join(request.runDir, 'transcript.jsonl');
      await writeFile(promptFile, request.prompt);
      const parser = createStreamParser();
      const result = await run({
        command: descriptor.command,
        args: buildArgs(descriptor, request, promptFile),
        cwd: request.workdir,
        env: agentEnv(descriptor, env),
        logFile: transcriptFile,
        timeoutMs: request.timeoutMs ?? descriptor.timeoutMs,
        killGraceMs: descriptor.killGraceMs,
        signal: request.signal,
        onLine: parser.push,
      });
      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        finalText: parser.finalText() || result.tail,
        tail: result.tail,
        transcriptFile,
        durationMs: result.durationMs,
      };
    },
  };
}

export function buildArgs(descriptor, request, promptFile) {
  const prompt = descriptor.promptDelivery === 'inline'
    ? request.prompt
    : `Read ${promptFile} and do exactly what it says. That file is your whole task. Write the result file it names before you stop.`;
  const args = ['-p', prompt];
  args.push('--output-format', descriptor.outputFormat ?? 'text');
  const model = request.model ?? descriptor.model;
  if (model) args.push('-m', model);
  for (const dir of request.skillsDirs ?? descriptor.skillsDirs ?? []) args.push('--skills-dir', path.resolve(request.workdir, dir));
  for (const dir of request.addDirs ?? []) args.push('--add-dir', dir);
  return args;
}

export function agentEnv(descriptor, env) {
  const out = {};
  for (const key of descriptor.env?.pass ?? []) if (env[key] !== undefined) out[key] = env[key];
  return { ...out, ...(descriptor.env?.set ?? {}) };
}

/** Tolerant: each stdout line may be JSON; the last assistant text wins. Non-JSON lines are ignored. */
export function createStreamParser() {
  let last = '';
  return {
    push(line) {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      const text = textOf(event);
      if (text && isAssistant(event)) last = text;
    },
    finalText: () => last.trim(),
  };
}

function isAssistant(event) {
  const role = event?.role ?? event?.message?.role ?? event?.data?.role;
  const type = String(event?.type ?? '');
  return role === 'assistant' || /assistant|agent\.message|result/.test(type);
}

function textOf(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.result === 'string') return value.result;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) return value.content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  return textOf(value.message ?? value.data);
}
