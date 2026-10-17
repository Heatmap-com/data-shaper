const ID = /^[a-z][a-z0-9-]{0,47}$/;
const KINDS = new Set(['queue', 'agents', 'handlers', 'checks', 'journal', 'site-directory']);

/** The only place an id becomes a module. It knows nothing about what the module does. */
export async function loadPlugin(kind, id) {
  if (!KINDS.has(kind)) throw new Error(`unknown adapter kind ${kind}`);
  if (!ID.test(id ?? '')) throw new Error(`bad ${kind} adapter id ${JSON.stringify(id)}`);
  const url = new URL(`../adapters/${kind}/${id}.js`, import.meta.url);
  try {
    return await import(url.href);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(url.pathname)) throw new Error(`no ${kind} adapter "${id}"`);
    throw err;
  }
}

/**
 * Lazy registry of handler and check modules. A module exports `adapter`, or
 * `createAdapter(deps)` when it needs ports; `deps` is what this registry was
 * built with.
 */
export function createRegistry(kind, deps = {}) {
  const cache = new Map();
  return {
    async get(id) {
      if (!cache.has(id)) {
        const mod = await loadPlugin(kind, id);
        const adapter = typeof mod.createAdapter === 'function' ? mod.createAdapter(deps) : mod.adapter;
        if (!adapter || adapter.id !== id) throw new Error(`${kind}/${id}.js must export adapter or createAdapter with id "${id}"`);
        cache.set(id, adapter);
      }
      return cache.get(id);
    },
  };
}

/** Agents are descriptor first: the descriptor names its adapter. */
export function createAgentRegistry({ descriptors, deps }) {
  const cache = new Map();
  return {
    async get(id) {
      if (!cache.has(id)) {
        const descriptor = await descriptors.agent(id);
        const mod = await loadPlugin('agents', descriptor.adapter);
        if (typeof mod.createAgent !== 'function') throw new Error(`agents/${descriptor.adapter}.js has no createAgent`);
        cache.set(id, mod.createAgent(descriptor, deps));
      }
      return cache.get(id);
    },
  };
}
