#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createContainer } from './composition/container.js';
import { OrchestratorError } from './domain/errors.js';
import { queueName } from './domain/job.js';
import { summary } from './application/job-admin.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const print = (value) => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);

const USAGE = `usage: orchestrator <command>

  validate [--site slug]
  explain <site> [--run ref] [--set k=v]
  enqueue <site|domain> [--run ref] [--priority p] [--resilience r] [--pages u,u] [--set k=v] [--note text] [--start]
  start
  run [--stages a,b] [--until-idle] [--once]
  status [--json]
  priority <job|domain> <critical|high|normal|low>
  note <job|domain> --text <text>
  retry <job|domain> [--stage id] [--refresh]
  complete <job|domain> [--stage id] --note <why it is done>   (stages whose check is still pending)
  cancel <job|domain> [--reason text]
  clear [--finished] [--all]
  dlq [--stage id] | dlq revive <messageId>
  jobs [--status s]
  show <job|domain>
  import-legacy [--file process/queue/queue.json] [--dry-run]

A <job|domain> is a job id, or a domain or site slug with one open job (else its newest job).
Every command takes --config <file> (default orchestrator.config.json).`;

function parseSets(list) {
  return (list ?? []).map((entry) => {
    const eq = String(entry).indexOf('=');
    if (eq === -1) throw new OrchestratorError(`--set expects k=v, got "${entry}"`, { exitCode: 2 });
    const key = entry.slice(0, eq);
    const raw = entry.slice(eq + 1);
    let value;
    try { value = JSON.parse(raw); } catch { value = raw; }
    return [key, value];
  });
}

function required(positionals, index, name) {
  const value = positionals[index];
  if (!value) throw new OrchestratorError(`missing <${name}>\n${USAGE}`, { exitCode: 2 });
  return value;
}

const string = { type: 'string' };
const flag = { type: 'boolean' };

/** command → its options and what it does with the container. A returned value is printed. */
const COMMANDS = {
  validate: {
    options: { site: string },
    action: (c, { values }) => c.validateLibrary({ site: values.site }),
  },
  explain: {
    options: { run: string, set: { type: 'string', multiple: true } },
    action: (c, { values, positionals }) => c.explain({ site: required(positionals, 0, 'site'), run: values.run, sets: parseSets(values.set) }),
  },
  enqueue: {
    options: { run: string, priority: string, resilience: string, pages: string, set: { type: 'string', multiple: true }, note: string, start: flag },
    action: async (c, { values, positionals }) => {
      const job = await c.enqueue({
        site: required(positionals, 0, 'site|domain'),
        run: values.run,
        priority: values.priority,
        resilience: values.resilience,
        pages: values.pages?.split(','),
        sets: parseSets(values.set),
        note: values.note,
      });
      const place = await c.admin.position(job);
      const lower = place.aheadOfLower ? `, ahead of ${place.aheadOfLower} lower-priority job${place.aheadOfLower === 1 ? '' : 's'}` : '';
      let message = `${job.site.domain} queued for run ${job.run.id}: ${job.priority} priority, ${job.resilience} resilience. Waiting position ${place.position}${lower}. Queue length ${place.length}.`;
      let worker = null;
      if (values.start) {
        worker = await c.startWorkers();
        message += ` ${worker.message}`;
      }
      return { message, ...place, worker, job };
    },
  },
  start: {
    options: {},
    action: (c) => c.startWorkers(),
  },
  run: {
    options: { stages: string, 'until-idle': flag, once: flag },
    action: (c, { values }) => runWorkers(c, values),
  },
  status: {
    options: { json: flag },
    action: async (c, { values }) => (values.json ? c.statusSnapshot() : c.status()),
  },
  priority: {
    options: {},
    action: (c, { positionals }) => c.admin.priority(required(positionals, 0, 'job|domain'), required(positionals, 1, 'level')),
  },
  note: {
    options: { text: string },
    action: (c, { values, positionals }) => c.admin.note(required(positionals, 0, 'job|domain'), values.text ?? positionals.slice(1).join(' ')),
  },
  retry: {
    options: { stage: string, refresh: flag },
    action: (c, { values, positionals }) => c.admin.retry(required(positionals, 0, 'job|domain'), { stage: values.stage, refresh: Boolean(values.refresh) }),
  },
  complete: {
    options: { stage: string, note: string },
    action: (c, { values, positionals }) => c.admin.complete(required(positionals, 0, 'job|domain'), { stage: values.stage, note: values.note }),
  },
  cancel: {
    options: { reason: string },
    action: (c, { values, positionals }) => c.admin.cancel(required(positionals, 0, 'job|domain'), values.reason),
  },
  clear: {
    options: { finished: flag, all: flag },
    action: (c, { values }) => c.admin.clear({ waiting: !values.finished || Boolean(values.all), finished: Boolean(values.finished || values.all) }),
  },
  dlq: {
    options: { stage: string },
    action: async (c, { values, positionals }) => {
      if (positionals[0] === 'revive') {
        const id = required(positionals, 1, 'messageId');
        await c.store.queue.revive(id);
        return { revived: id };
      }
      return c.store.queue.listDead(values.stage ? queueName(values.stage) : undefined);
    },
  },
  jobs: {
    options: { status: string },
    action: async (c, { values }) => (await c.store.jobs.list(values.status ? { status: values.status.split(',') } : {})).map(summary),
  },
  show: {
    options: {},
    action: (c, { positionals }) => c.admin.show(required(positionals, 0, 'job|domain')),
  },
  'import-legacy': {
    options: { file: string, 'dry-run': flag },
    action: (c, { values }) => c.importLegacy({ file: values.file, dryRun: Boolean(values['dry-run']) }),
  },
};

async function runWorkers(container, values) {
  const ids = values.stages?.split(',') ?? await container.descriptors.stageIds();
  if (!ids.length) throw new OrchestratorError('no stages in the library to run');
  const stages = await Promise.all(ids.map(async (id) => ({ ...(await container.descriptors.stage(id)), id })));
  const workers = stages.map((stage) => container.makeWorker(stage, { once: Boolean(values.once) }));

  const beat = () => container.store.workers.heartbeat({ owner: container.owner, pid: process.pid, host: os.hostname(), stages: ids });
  await beat();
  const heartbeat = setInterval(() => beat().catch(() => {}), container.config.worker.heartbeatMs);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    clearInterval(idleWatch);
    await Promise.all(workers.map((worker) => worker.stop()));
    await container.store.workers.remove(container.owner).catch(() => {});
  };
  process.on('SIGINT', () => shutdown().then(() => process.exit(130)));
  process.on('SIGTERM', () => shutdown().then(() => process.exit(143)));
  process.on('SIGHUP', () => shutdown().then(() => process.exit(129)));

  const idleWatch = values['until-idle'] ? setInterval(async () => {
    const stats = await container.store.queue.stats().catch(() => []);
    const open = stats.filter((row) => ids.some((id) => row.queue === queueName(id)));
    if (open.every((row) => row.ready === 0 && row.delayed === 0 && row.leased === 0)) await shutdown();
  }, Math.max(100, container.config.worker.pollMs)) : null;

  const running = workers.map((worker) => worker.start().catch((err) => {
    if (stopping || err?.name === 'AbortError') return;
    console.error(err);
    process.exitCode = 1;
    shutdown();
  }));
  await Promise.all(running);
  if (values.once) await shutdown();
  else if (!values['until-idle']) await new Promise(() => {});
  else while (!stopping) await new Promise((resolve) => setTimeout(resolve, 100));
}

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  if (name === 'help' || name === '--help' || name === '-h') {
    print(USAGE);
    return;
  }
  const command = Object.hasOwn(COMMANDS, name ?? '') ? COMMANDS[name] : null;
  if (!command) throw new OrchestratorError(`unknown command "${name ?? ''}"\n${USAGE}`, { exitCode: 2 });
  const args = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { config: { type: 'string', default: 'orchestrator.config.json' }, ...command.options },
  });
  const container = await createContainer({ repoRoot, configFile: args.values.config, logger: console });
  try {
    const result = await command.action(container, args);
    if (result !== undefined) print(result);
  } finally {
    await container.close?.();
  }
}

main().catch((err) => {
  if (err instanceof OrchestratorError) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = err.exitCode;
  } else {
    console.error(err);
    process.exitCode = 1;
  }
});
