// Entity names. names/<site>.json holds placeholder names now; the naming feature will write the same shape.
export const NAME_TYPES = ['campaign', 'creative', 'selector', 'experiment', 'experiment_arm', 'page'];

export function shortSelector(sel) {
  const parts = String(sel ?? '').split(' > ').map((p) => p.replace(/:nth-child\(\d+\)/g, '').trim()).filter(Boolean);
  const meaningful = [...parts].reverse().find((p) => /[.#]/.test(p)) ?? parts[parts.length - 1] ?? '';
  const text = meaningful.replace(/^[a-z-]+(?=[.#])/, '');
  return text.length > 28 ? `…${text.slice(-27)}` : text;
}

const tail = (v, n = 6) => String(v).slice(-n);

export function makeNames(map = {}) {
  const get = (type, key) => (key === null || key === undefined ? null : map[type]?.[String(key)] ?? null);
  return {
    map,
    resolve(type, key, row = {}) {
      const hit = get(type, key);
      if (hit) return { label: hit.name, placeholder: hit.placeholder !== false, source: 'map', id: key };
      if (key === null || key === undefined || key === '') return { label: '(none)', placeholder: false, source: 'data', id: key };
      if (type === 'selector') {
        if (row.name) return { label: row.name, placeholder: false, source: 'data', id: key };
        if (row.x_am_label) return { label: row.x_am_label, placeholder: false, source: 'data', id: key };
        return { label: shortSelector(row.selector ?? key), placeholder: false, source: 'id', id: key };
      }
      if (type === 'campaign') return { label: /^\d+$/.test(String(key)) ? `campaign …${tail(key)}` : String(key), placeholder: false, source: 'id', id: key };
      if (type === 'creative') return { label: /^\d+$/.test(String(key)) ? `creative …${tail(key)}` : String(key).slice(0, 40), placeholder: false, source: 'id', id: key };
      if (type === 'experiment_arm') return { label: row.is_control ? 'Control' : `Arm …${String(key).split('|').pop().slice(0, 6)}`, placeholder: false, source: 'id', id: key };
      return { label: String(key), placeholder: false, source: 'id', id: key };
    },
    title(type, key, row) {
      const r = this.resolve(type, key, row);
      const bits = [];
      if (r.placeholder) bits.push('Placeholder name (prototype)');
      if (type === 'selector' && row?.selector) bits.push(row.selector);
      else if (key !== null && key !== undefined && String(key) !== r.label) bits.push(`ID ${key}`);
      return bits.join(' · ') || null;
    },
    counts() {
      const out = {};
      for (const t of NAME_TYPES) out[t] = Object.values(map[t] ?? {}).filter((v) => v.placeholder !== false).length;
      return out;
    },
  };
}
