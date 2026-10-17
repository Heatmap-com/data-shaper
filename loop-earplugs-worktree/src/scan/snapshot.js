/**
 * A JSON text for a folder's state that keeps Maps, Sets, and shared
 * references: an object reached twice decodes to one object. The trigger
 * folder holds one session in its day, visitor, and prior-purchase maps at
 * once, and merges by identity.
 *
 * Each object becomes a node: `{a: [...]}` for an array, `{m: [[k, v]...]}`
 * for a Map, `{s: [...]}` for a Set, `{o: [[key, v]...]}` for a plain
 * object. A value is a primitive or `{r: id}`.
 */

/**
 * With `maxBytes`, the encoder keeps a running estimate of the text's
 * length and returns null once it passes the cap, before the text exists:
 * a large site's state can exceed the longest string the runtime allows.
 * @param {unknown} root
 * @param {{maxBytes?: number}} [opts]
 * @returns {string | null}
 */
export function encodeSnapshot(root, { maxBytes = Infinity } = {}) {
  /** @type {object[]} */
  const nodes = [];
  /** @type {Map<object, number>} */
  const ids = new Map();
  /** @type {Array<[number, object]>} */
  const pending = [];
  let estimate = 0;

  const ref = (value) => {
    if (value === undefined) {
      estimate += 5;
      return null;
    }
    if (value === null || typeof value !== 'object') {
      estimate += typeof value === 'string' ? value.length + 3 : 12;
      return value;
    }
    let id = ids.get(value);
    if (id === undefined) {
      id = nodes.length;
      ids.set(value, id);
      nodes.push(null);
      pending.push([id, value]);
    }
    estimate += 16;
    return { r: id };
  };

  const top = ref(root);
  while (pending.length > 0) {
    if (estimate > maxBytes) return null;
    const [id, value] = pending.pop();
    if (Array.isArray(value)) nodes[id] = { a: value.map(ref) };
    else if (value instanceof Map) nodes[id] = { m: [...value].map(([k, v]) => [ref(k), ref(v)]) };
    else if (value instanceof Set) nodes[id] = { s: [...value].map(ref) };
    else nodes[id] = { o: Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, ref(v)]) };
  }
  if (estimate > maxBytes) return null;
  const text = JSON.stringify({ top, nodes });
  return text.length > maxBytes ? null : text;
}

/** @param {string} text @returns {any} */
export function decodeSnapshot(text) {
  const { top, nodes } = JSON.parse(text);
  const shells = nodes.map((node) => ('a' in node ? [] : 'm' in node ? new Map() : 's' in node ? new Set() : {}));
  const value = (v) => (v !== null && typeof v === 'object' ? shells[v.r] : v);
  nodes.forEach((node, id) => {
    const shell = shells[id];
    if ('a' in node) for (const item of node.a) shell.push(value(item));
    else if ('m' in node) for (const [k, v] of node.m) shell.set(value(k), value(v));
    else if ('s' in node) for (const item of node.s) shell.add(value(item));
    else for (const [k, v] of node.o) shell[k] = value(v);
  });
  return value(top);
}

/**
 * A folder's `snapshot` and `restore` when its state is one Map.
 * @param {Map<unknown, unknown>} map
 */
export function mapState(map) {
  return {
    snapshot: () => map,
    /** @param {Map<unknown, unknown>} saved */
    restore(saved) {
      map.clear();
      for (const [key, value] of saved) map.set(key, value);
    },
  };
}
