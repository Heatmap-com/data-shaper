const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Objects merge by key. Arrays and scalars replace. `null` in the patch removes the key. */
export function deepMerge(base, patch) {
  if (patch === undefined) return structuredClone(base);
  if (!isPlain(base) || !isPlain(patch)) return structuredClone(patch);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = deepMerge(base[key], value);
  }
  return out;
}

export function setPath(target, dotted, value) {
  const out = structuredClone(target);
  const keys = dotted.split('.');
  let node = out;
  for (const key of keys.slice(0, -1)) {
    if (Array.isArray(node) && !/^\d+$/.test(key)) {
      node = node.find((entry) => entry?.id === key) ?? (() => { throw new Error(`--set: no stage ${key}`); })();
      continue;
    }
    node[key] = isPlain(node[key]) || Array.isArray(node[key]) ? node[key] : {};
    node = node[key];
  }
  node[keys.at(-1)] = value;
  return out;
}
