import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { agentEnv, buildArgs, createAgent, createStreamParser } from '../../src/orchestrator/adapters/agents/kimi-cli.js';
import { agentUnavailable } from '../../src/orchestrator/domain/failure.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureFile = path.join(repoRoot, 'test', 'fixtures', 'orchestrator', 'kimi-stream.jsonl');
const FINAL_TEXT = 'Wrote "ok" to `./out.txt`.';

const dirs = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'orch-kimi-'));
  dirs.push(dir);
  return dir;
}

const request = (overrides = {}) => ({
  prompt: 'do the thing',
  runDir: '/run/dir',
  workdir: '/work',
  ...overrides,
});

describe('buildArgs', () => {
  it('never emits --auto or --yolo; prompt mode is already non-interactive', () => {
    for (const mode of ['auto', 'yolo', undefined]) {
      const args = buildArgs({ id: 'kimi', command: 'kimi', mode }, request(), '/run/dir/prompt.md');
      expect(args).not.toContain('--auto');
      expect(args).not.toContain('--yolo');
    }
  });

  it('starts with -p and the read-prompt-file instruction by default', () => {
    const args = buildArgs({ id: 'kimi', command: 'kimi' }, request(), '/run/dir/prompt.md');
    expect(args[0]).toBe('-p');
    expect(args[1]).toContain('Read /run/dir/prompt.md and do exactly what it says.');
    expect(args[1]).not.toContain('do the thing');
  });

  it('passes the prompt inline when promptDelivery is inline', () => {
    const args = buildArgs({ id: 'kimi', command: 'kimi', promptDelivery: 'inline' }, request(), '/run/dir/prompt.md');
    expect(args[1]).toBe('do the thing');
  });

  it('resolves --skills-dir against the workdir and repeats --add-dir', () => {
    const args = buildArgs(
      { id: 'kimi', command: 'kimi', skillsDirs: ['skills', '../more-skills'] },
      request({ addDirs: ['/a', '/b'] }),
      '/run/dir/prompt.md',
    );
    expect(args).toContain('--skills-dir');
    expect(args[args.indexOf('--skills-dir') + 1]).toBe('/work/skills');
    expect(args[args.lastIndexOf('--skills-dir') + 1]).toBe('/more-skills');
    expect(args.filter((arg) => arg === '--add-dir')).toHaveLength(2);
    expect(args).toEqual(expect.arrayContaining(['--add-dir', '/a', '--add-dir', '/b']));
  });

  it('emits -m only when a model is set, request over descriptor', () => {
    const noModel = buildArgs({ id: 'kimi', command: 'kimi' }, request(), '/run/dir/prompt.md');
    expect(noModel).not.toContain('-m');
    const fromDescriptor = buildArgs({ id: 'kimi', command: 'kimi', model: 'k2' }, request(), '/run/dir/prompt.md');
    expect(fromDescriptor[fromDescriptor.indexOf('-m') + 1]).toBe('k2');
    const fromRequest = buildArgs({ id: 'kimi', command: 'kimi', model: 'k2' }, request({ model: 'k2-thinking' }), '/run/dir/prompt.md');
    expect(fromRequest[fromRequest.indexOf('-m') + 1]).toBe('k2-thinking');
  });

  it('uses the descriptor output format, defaulting to text', () => {
    const plain = buildArgs({ id: 'kimi', command: 'kimi' }, request(), '/run/dir/prompt.md');
    expect(plain[plain.indexOf('--output-format') + 1]).toBe('text');
    const stream = buildArgs({ id: 'kimi', command: 'kimi', outputFormat: 'stream-json' }, request(), '/run/dir/prompt.md');
    expect(stream[stream.indexOf('--output-format') + 1]).toBe('stream-json');
  });
});

describe('createStreamParser', () => {
  it('pins the recorded stream-json fixture: the last assistant text wins, meta content does not', async () => {
    const parser = createStreamParser();
    const raw = await readFile(fixtureFile, 'utf8');
    for (const line of raw.split('\n').filter(Boolean)) parser.push(line);
    expect(parser.finalText()).toBe(FINAL_TEXT);
  });

  it('ignores non-JSON lines', () => {
    const parser = createStreamParser();
    parser.push('not json at all');
    parser.push(JSON.stringify({ role: 'assistant', content: 'done here' }));
    parser.push('{broken');
    expect(parser.finalText()).toBe('done here');
  });
});

describe('agentEnv', () => {
  it('passes only listed env keys plus set overrides', () => {
    const descriptor = { id: 'kimi', env: { pass: ['KEPT', 'MISSING'], set: { EXTRA: 'yes' } } };
    const out = agentEnv(descriptor, { KEPT: 'value', OTHER: 'no' });
    expect(out).toEqual({ KEPT: 'value', EXTRA: 'yes' });
  });

  it('handles a descriptor with no env block', () => {
    expect(agentEnv({ id: 'kimi' }, { A: '1' })).toEqual({});
  });
});

describe('createAgent run', () => {
  it('writes prompt.md, replays the fixture through onLine, and returns the final text', async () => {
    const dir = await tempDir();
    const raw = await readFile(fixtureFile, 'utf8');
    const calls = [];
    const run = async (options) => {
      calls.push(options);
      for (const line of raw.split('\n').filter(Boolean)) options.onLine(line);
      return { exitCode: 0, exitSignal: null, timedOut: false, aborted: false, tail: '', durationMs: 7 };
    };
    const agent = createAgent(
      { id: 'kimi-cli', command: 'kimi', outputFormat: 'stream-json', timeoutMs: 60_000 },
      { run, env: {} },
    );
    const result = await agent.run(request({ runDir: dir, workdir: dir }));
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, aborted: false, finalText: FINAL_TEXT, durationMs: 7 });
    expect(result.transcriptFile).toBe(path.join(dir, 'transcript.jsonl'));
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('kimi');
    expect(calls[0].cwd).toBe(dir);
    expect(calls[0].timeoutMs).toBe(60_000);
    expect(calls[0].logFile).toBe(path.join(dir, 'transcript.jsonl'));
    const prompt = await readFile(path.join(dir, 'prompt.md'), 'utf8');
    expect(prompt).toBe('do the thing');
    expect(calls[0].args[1]).toContain(path.join(dir, 'prompt.md'));
  });

  it('falls back to the process tail when the stream has no assistant text', async () => {
    const dir = await tempDir();
    const run = async () => ({ exitCode: 1, exitSignal: null, timedOut: false, aborted: false, tail: 'raw failure tail', durationMs: 3 });
    const agent = createAgent({ id: 'kimi-cli', command: 'kimi' }, { run, env: {} });
    const result = await agent.run(request({ runDir: dir, workdir: dir }));
    expect(result.finalText).toBe('raw failure tail');
  });

  it('returns the raw tail too, so a usage limit after assistant text is still seen', async () => {
    const dir = await tempDir();
    const quota = "Error: 403 You've reached your monthly usage limit.";
    const run = async (options) => {
      options.onLine(JSON.stringify({ role: 'assistant', content: 'Reading the stage log first.' }));
      return { exitCode: 1, exitSignal: null, timedOut: false, aborted: false, tail: quota, durationMs: 3 };
    };
    const agent = createAgent({ id: 'kimi-cli', command: 'kimi' }, { run, env: {} });
    const result = await agent.run(request({ runDir: dir, workdir: dir }));
    expect(result.finalText).toBe('Reading the stage log first.');
    expect(agentUnavailable(result)).toBe(true);
  });
});
