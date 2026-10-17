import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../../src/orchestrator/adapters/queue/memory.js';
import { createAgent as createFakeAgent } from '../../src/orchestrator/adapters/agents/fake.js';
import { createStageExecutor } from '../../src/orchestrator/application/execute-stage.js';
import { createAgenticFallback } from '../../src/orchestrator/application/agentic-fallback.js';
import { createSettler } from '../../src/orchestrator/application/settle.js';
import { createGovernor } from '../../src/orchestrator/application/governor.js';
import { createWorkspace } from '../../src/orchestrator/adapters/workspace/fs.js';
import { createContexts } from '../../src/orchestrator/application/context.js';
import { createJob, messageFor, queueName } from '../../src/orchestrator/domain/job.js';
import { sleep } from '../../src/orchestrator/application/util.js';

export const RESILIENCE = {
  standard: { fallbackAttempts: 1, repairScope: 'standard scope' },
  top: { fallbackAttempts: 3, repairScope: 'top scope' },
};

export const PAGE_URLS = ['https://acme.test/', 'https://acme.test/products/a', 'https://acme.test/collections/b'];

export function makeStage(overrides = {}) {
  return {
    id: 'naming',
    label: 'Naming',
    forEach: 'pages',
    handler: { use: 'fake-handler' },
    check: { use: 'fake-check' },
    errors: [{ match: 'ENOTFOUND', class: 'transient', reason: 'DNS lookup failed' }],
    retry: { maxAttempts: 3, backoffMs: 1000, factor: 2, maxBackoffMs: 10_000, jitter: 0.2 },
    ...overrides,
  };
}

export function makeJob({ id, pages, stages = [makeStage()], resilience = 'standard' } = {}) {
  const run = { id: 'default', defaults: {}, pages: null, stages };
  const now = new Date('2026-10-13T07:15:30.000Z');
  return createJob({
    id: id ?? `acme-20261013-071530-${Math.random().toString(36).slice(2, 6)}`,
    site: { slug: 'acme', domain: 'acme.test', origin: 'https://acme.test/', idsite: 7 },
    pages: (pages ?? PAGE_URLS).map((url) => ({ url })),
    window: { start: '2026-09-13', end: '2026-10-12' },
    priority: 'normal',
    resilience,
    resolved: { run, refs: [], hash: 'test' },
    now,
  });
}

/**
 * Memory store, fake handler/check driven by a unit-key -> state map
 * ('complete' | 'incomplete' | 'broken' | 'fails:<tag>'), the fake agent, and
 * the real executor/fallback/settler/governor wired together.
 */
export async function makeRig({ states = {}, handler, behave, capacity = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'orch-scenario-'));
  const clock = { now: () => new Date() };
  const store = createStore({ clock });
  const journal = [];
  const journalPort = { record: async (job, event) => { journal.push(event); } };
  const state = new Map(Object.entries(states));
  const calls = { handler: 0, agent: 0 };

  const fakeHandler = {
    id: 'fake-handler',
    run: handler ?? (async (ctx) => {
      calls.handler += 1;
      const current = state.get(ctx.unit.key) ?? 'incomplete';
      if (current.startsWith('fails:')) {
        state.set(ctx.unit.key, 'incomplete');
        return { status: 'error', message: 'exit 1', exitCode: 1, command: 'fake', logTail: `Error: getaddrinfo ${current.slice(6)} acme.test` };
      }
      if (current === 'broken') {
        return { status: 'error', message: 'exit 1', exitCode: 1, command: 'fake', logTail: 'permanent failure' };
      }
      state.set(ctx.unit.key, 'complete');
      return { status: 'ok', exitCode: 0, command: 'fake' };
    }),
  };
  const fakeCheck = {
    id: 'fake-check',
    describe: () => 'unit state is complete',
    evaluate: async (ctx) => {
      const ok = state.get(ctx.unit.key) === 'complete';
      return { ok, summary: ok ? `${ctx.unit.key} complete` : `${ctx.unit.key} incomplete`, details: [{ name: ctx.unit.key, ok }] };
    },
  };
  const registries = {
    handlers: {
      async get(id) {
        if (id !== 'fake-handler') throw new Error(`unknown handler ${id}`);
        return fakeHandler;
      },
    },
    checks: {
      async get(id) {
        if (id !== 'fake-check') throw new Error(`unknown check ${id}`);
        return fakeCheck;
      },
    },
  };
  const agent = createFakeAgent({ id: 'fake' }, {
    behave: async (request) => {
      calls.agent += 1;
      return behave?.(request, state);
    },
  });
  const agents = { get: async () => agent };
  const prompts = {
    render: async (name) => ({ text: `prompt ${name}`, sources: ['test.md'] }),
    sources: async () => ['test.md'],
  };
  const descriptors = { resilience: async () => RESILIENCE };
  const workspace = createWorkspace({ root: path.join(root, 'runs') });
  const contexts = createContexts({ repoRoot: root, config: { values: { analysisRoot: root } }, workspace, descriptors, env: {} });
  const governor = createGovernor({ resources: store.resources, capacity, leaseMs: 2000, sleep, pollMs: 20 });
  const fallback = createAgenticFallback({ agents, prompts, checks: registries.checks, jobs: store.jobs, journal: journalPort, governor, workspace, descriptors });
  const executor = createStageExecutor({ jobs: store.jobs, handlers: registries.handlers, checks: registries.checks, fallback, governor, journal: journalPort, contexts, random: () => 0.5 });
  const settle = createSettler({ queue: store.queue, jobs: store.jobs, journal: journalPort, clock });

  return {
    root, store, journal, state, calls, executor, settle, governor, workspace, sleep,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function queueJob(rig, job, stageId = job.run.stages[0].id) {
  job.stages[stageId].status = 'queued';
  await rig.store.jobs.create(job);
  const stage = job.run.stages.find((row) => row.id === stageId);
  await rig.store.queue.enqueue(queueName(stageId), messageFor(job, stage));
}

export async function deliver(rig, jobId, stageId, owner = 'test-worker') {
  const lease = await rig.store.queue.reserve(queueName(stageId), { leaseMs: 60_000, owner });
  if (!lease) throw new Error(`no message ready for ${stageId}`);
  const outcome = await rig.executor.execute({ jobId, stageId, owner, signal: new AbortController().signal });
  await rig.settle(lease, outcome);
  return { lease, outcome };
}

export const journalTypes = (rig, type) => rig.journal.filter((event) => event.type === type);
