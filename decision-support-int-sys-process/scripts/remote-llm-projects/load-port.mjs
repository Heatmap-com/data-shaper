import { readFile } from 'node:fs/promises';

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Composition: one descriptor file plus one adapter module, chosen by id.
 * Adding a provider is a new pair of those files. This loader is the only
 * place that maps an id onto code, and it does not know what any provider does.
 *
 * @param {string} providerId
 * @param {{ fetch?: typeof fetch, env?: NodeJS.ProcessEnv }} [deps]
 * @returns {Promise<import('./ports/remote-project.mjs').RemoteProjectPort>}
 */
export async function loadProjectPort(providerId, deps) {
  if (!PROVIDER_ID.test(providerId ?? '')) {
    throw new Error(`unknown provider: ${providerId}`);
  }
  const descriptorUrl = new URL(`./descriptors/${providerId}.json`, import.meta.url);
  let descriptor;
  try {
    descriptor = JSON.parse(await readFile(descriptorUrl, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') throw new Error(`unknown provider: ${providerId}`);
    throw err;
  }
  const adapter = await import(`./adapters/${providerId}.mjs`);
  if (typeof adapter.createAdapter !== 'function') {
    throw new Error(`provider ${providerId} has no adapter`);
  }
  return adapter.createAdapter(descriptor, deps);
}
