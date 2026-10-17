import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DescriptorError, NotFoundError } from '../../domain/errors.js';
import { bareDomain } from '../../domain/site.js';

const ID = /^[a-z][a-z0-9-]{0,47}$/;

/**
 * Reads the descriptor tree: stages/<id>.stage.json, agents/<id>.agent.json,
 * general/resilience.json, general/runs/<name>.run.json,
 * sites/<slug>/runs/<name>.run.json, and sites/<slug>/site.json.
 *
 * @param {{root: string}} options
 * @returns {import('../../ports/descriptor-source.js').DescriptorSourcePort}
 */
export function createFsDescriptorSource({ root }) {
  return { stage, stageIds, agent, resilience, run, runFile, runFiles, site, sites };

  async function runFiles(slug) {
    const out = [];
    for (const dir of [path.join(root, 'general', 'runs'), path.join(root, 'sites', slug, 'runs')]) {
      let names = [];
      try {
        names = await readdir(dir);
      } catch (err) {
        if (err?.code === 'ENOENT') continue;
        throw err;
      }
      for (const name of names.filter((entry) => entry.endsWith('.run.json')).sort()) out.push(path.join(dir, name));
    }
    return out;
  }

  async function stage(id) {
    checkId(id);
    return readJson(path.join(root, 'stages', `${id}.stage.json`), `no stage descriptor "${id}"`);
  }

  async function stageIds() {
    let names;
    try {
      names = await readdir(path.join(root, 'stages'));
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
    return names.filter((name) => name.endsWith('.stage.json')).map((name) => name.slice(0, -'.stage.json'.length)).sort();
  }

  async function agent(id) {
    checkId(id);
    return readJson(path.join(root, 'agents', `${id}.agent.json`), `no agent descriptor "${id}"`);
  }

  async function resilience() {
    return readJson(path.join(root, 'general', 'resilience.json'), 'no general/resilience.json');
  }

  async function run(scope, name, slug) {
    if (!ID.test(name ?? '')) throw new DescriptorError(`invalid run name "${name}"`);
    if (scope === 'site') {
      if (!ID.test(slug ?? '')) throw new DescriptorError(`invalid site slug "${slug}"`);
      const file = path.join(root, 'sites', slug, 'runs', `${name}.run.json`);
      const body = await read(file);
      return body === null ? null : { body, file };
    }
    const file = path.join(root, 'general', 'runs', `${name}.run.json`);
    return { body: await readJson(file, `no run descriptor "general:${name}"`), file };
  }

  async function runFile(file) {
    return { body: await readJson(file, `no run descriptor at ${file}`), file };
  }

  async function site(slugOrDomain) {
    const wanted = bareDomain(slugOrDomain);
    for (const entry of await sites()) {
      if (entry.slug === slugOrDomain || bareDomain(entry.domain) === wanted) return entry;
    }
    return null;
  }

  async function sites() {
    let dirs;
    try {
      dirs = await readdir(path.join(root, 'sites'), { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
    const found = [];
    for (const dir of dirs.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
      const file = path.join(root, 'sites', dir, 'site.json');
      const body = await read(file);
      if (body) found.push({ slug: dir, ...body });
    }
    return found;
  }
}

function checkId(id) {
  if (!ID.test(id ?? '')) throw new DescriptorError(`invalid descriptor id "${id}"`);
}

async function read(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new DescriptorError(`${file}: not valid JSON`, { cause: err });
  }
}

async function readJson(file, missing) {
  const body = await read(file);
  if (body === null) throw new NotFoundError(missing);
  return body;
}
