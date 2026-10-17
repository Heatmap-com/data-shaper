import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { OrchestratorError } from '../domain/errors.js';

const DEFAULTS = {
  root: 'orchestration',
  workspace: 'process/runs',
  journalDir: 'process/journal',
  governor: { capacity: {}, leaseMs: 120_000 },
  worker: { pollMs: 2000, maxPollMs: 15_000, heartbeatMs: 15_000, maxDeliveries: 5 },
  values: {},
};

/**
 * Reads orchestrator.config.json. Relative store.path, workspace, and
 * journalDir resolve against repoRoot; leading ~ in config.values strings
 * expands to the home directory.
 */
export async function loadConfig(file, repoRoot) {
  let body;
  try {
    body = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    const hint = err?.code === 'ENOENT' ? ' Copy orchestrator.config.example.json to orchestrator.config.json and set the paths for this machine.' : '';
    throw new OrchestratorError(`cannot read config ${file}: ${err.message}.${hint}`, { cause: err });
  }
  const config = {
    ...DEFAULTS,
    ...body,
    governor: { ...DEFAULTS.governor, ...(body.governor ?? {}) },
    worker: { ...DEFAULTS.worker, ...(body.worker ?? {}) },
    values: expandValues(body.values ?? {}),
  };
  config.workspace = resolvePath(config.workspace, repoRoot);
  config.journalDir = resolvePath(config.journalDir, repoRoot);
  if (config.store?.path) config.store = { ...config.store, path: resolvePath(config.store.path, repoRoot) };
  return config;
}

const expandHome = (value) => (value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value);

function resolvePath(value, repoRoot) {
  const expanded = expandHome(String(value));
  return path.isAbsolute(expanded) ? expanded : path.resolve(repoRoot, expanded);
}

function expandValues(value) {
  if (typeof value === 'string') return expandHome(value);
  if (Array.isArray(value)) return value.map(expandValues);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandValues(entry)]));
  }
  return value;
}
