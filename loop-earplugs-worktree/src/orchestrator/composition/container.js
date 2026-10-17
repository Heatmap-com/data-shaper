import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { loadPlugin, createRegistry, createAgentRegistry } from './plugins.js';
import { createFsDescriptorSource } from '../adapters/descriptors/fs.js';
import { createLayeredPromptSource } from '../adapters/prompts/layered-fs.js';
import { createMarkdownJournal } from '../adapters/journal/markdown.js';
import { createEventsJournal } from '../adapters/journal/events.js';
import { createCompositeJournal } from '../adapters/journal/composite.js';
import { createRunResolver } from '../application/resolve-run.js';
import { createValidator } from '../domain/validate.js';
import { createEnqueue } from '../application/enqueue-job.js';
import { createStageExecutor } from '../application/execute-stage.js';
import { createAgenticFallback } from '../application/agentic-fallback.js';
import { createSettler } from '../application/settle.js';
import { createStageWorker } from '../application/stage-worker.js';
import { createGovernor } from '../application/governor.js';
import { createWorkspace } from '../adapters/workspace/fs.js';
import { createContexts } from '../application/context.js';
import { readStatus, statusSnapshot } from '../application/status.js';
import { newJobId, sleep } from '../application/util.js';
import { createJobAdmin } from '../application/job-admin.js';
import { createLibraryValidator } from '../application/validate-library.js';
import { createRunExplainer } from '../application/explain-run.js';
import { createLegacyImport } from '../application/import-legacy.js';
import { createWorkerStarter } from '../application/start-workers.js';
import { createLegacyQueueFile } from '../adapters/legacy/queue-json.js';
import { createDetachedLauncher } from '../adapters/launcher/detached.js';
import { createSiteWriter } from '../adapters/descriptors/site-writer.js';
import { createSiteResolver } from '../application/resolve-site.js';
import { clickHouseConfig, createClickHouseClient } from '../../composition/clickhouse.js';
import { createAeBatchReader } from './ae-batches.js';

export async function createContainer({ repoRoot, configFile = 'orchestrator.config.json', env = process.env, logger = console }) {
  const config = await loadConfig(path.resolve(repoRoot, configFile), repoRoot);
  const clock = { now: () => new Date() };
  const { createStore } = await loadPlugin('queue', config.store.adapter);
  const store = await createStore({ ...config.store, root: repoRoot, clock, env });

  const root = path.resolve(repoRoot, config.root);
  const descriptors = createFsDescriptorSource({ root });
  const prompts = createLayeredPromptSource({ root });
  const agents = createAgentRegistry({ descriptors, deps: { env } });
  const checks = createRegistry('checks', { aeBatches: createAeBatchReader({ connect: () => createClickHouseClient(clickHouseConfig(env)) }) });
  const workspace = createWorkspace({ root: config.workspace });
  const handlers = createRegistry('handlers', { agents, prompts, checks, workspace });
  const journal = createCompositeJournal([createMarkdownJournal({ dir: config.journalDir, clock }), createEventsJournal(store.events)], logger);
  const governor = createGovernor({ resources: store.resources, capacity: config.governor.capacity, leaseMs: config.governor.leaseMs, sleep, host: os.hostname() });
  const resolver = createRunResolver({ descriptors });
  const validator = createValidator({ descriptors, prompts, handlers, checks, capacity: config.governor.capacity, values: config.values ?? {} });
  const contexts = createContexts({ repoRoot, config, workspace, descriptors, env });
  const fallback = createAgenticFallback({ agents, prompts, checks, jobs: store.jobs, journal, governor, workspace, descriptors });
  const executor = createStageExecutor({ jobs: store.jobs, handlers, checks, fallback, governor, journal, contexts });
  const settle = createSettler({ queue: store.queue, jobs: store.jobs, journal, clock });
  const { createSiteDirectory } = await loadPlugin('site-directory', config.siteDirectory?.adapter ?? 'clickhouse');
  const directory = createSiteDirectory({ connect: () => createClickHouseClient(clickHouseConfig(env)) });
  const siteResolver = createSiteResolver({ descriptors, directory });
  const registry = createSiteWriter({ root });
  const enqueue = createEnqueue({ siteResolver, registry, resolver, validator, jobs: store.jobs, queue: store.queue, journal, clock, newId: newJobId });
  const admin = createJobAdmin({ jobs: store.jobs, queue: store.queue, events: store.events, journal, resolver, clock });
  const validateLibrary = createLibraryValidator({ descriptors, resolver, validator, clock });
  const explain = createRunExplainer({ descriptors, resolver, prompts });
  const legacyImport = createLegacyImport({ siteResolver, registry, resolver, validator, jobs: store.jobs, queue: store.queue, journal });
  const launcher = createDetachedLauncher({
    cli: path.join(repoRoot, 'src', 'orchestrator', 'cli.js'),
    configFile: path.resolve(repoRoot, configFile),
    logDir: path.join(config.workspace, 'workers'),
    cwd: repoRoot,
    clock,
    env,
  });
  const startWorkers = createWorkerStarter({ workers: store.workers, queue: store.queue, launcher, clock, heartbeatMs: config.worker.heartbeatMs });
  const owner = `${os.hostname()}:${process.pid}`;

  return {
    config, store, descriptors, prompts, resolver, validator, enqueue, admin, validateLibrary, explain, startWorkers, owner,
    importLegacy: ({ file = 'process/queue/queue.json', dryRun = false } = {}) => legacyImport({ source: createLegacyQueueFile({ file, root: repoRoot }), dryRun }),
    statusSnapshot: () => statusSnapshot({ store, descriptors, config, clock }),
    makeWorker: (stage, overrides = {}) => createStageWorker({ stage, queue: store.queue, executor, settle, logger, sleep, options: { ...config.worker, owner, leaseMs: stage.leaseMs ?? 120_000, ...overrides } }),
    status: () => readStatus({ store, descriptors, config, clock }),
    close: async () => {
      await directory.close?.();
      store.close?.();
    },
  };
}
