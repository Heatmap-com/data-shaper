// Pins, the client-brief export and the local task log. Nothing leaves the browser.

const LOG = 'qt:chatgpt-v1:log';

export function pinKey(site, snap) {
  return `qt:chatgpt-v1:${site}:${snap}`;
}

export function readPins(site, snap) {
  try {
    const raw = JSON.parse(localStorage.getItem(pinKey(site, snap)) || '{}');
    return { findings: raw.findings ?? [], action: raw.action ?? '' };
  } catch {
    return { findings: [], action: '' };
  }
}

export function writePins(site, snap, data) {
  localStorage.setItem(pinKey(site, snap), JSON.stringify({ findings: data.findings.slice(0, 3), action: data.action ?? '' }));
}

export function addPin(site, snap, pin) {
  const data = readPins(site, snap);
  if (data.findings.some((p) => p.id === pin.id)) return data;
  if (data.findings.length >= 3) return data;
  data.findings.push(pin);
  writePins(site, snap, data);
  return data;
}

export function removePin(site, snap, id) {
  const data = readPins(site, snap);
  data.findings = data.findings.filter((p) => p.id !== id);
  writePins(site, snap, data);
  return data;
}

let lastSig = '';
export function logEvent(event, extra = {}) {
  const row = { t: new Date().toISOString(), event, tab: extra.tab ?? null, context: extra.context ?? null, ev: extra.ev ?? null };
  const sig = JSON.stringify(row);
  if (sig === lastSig) return;
  lastSig = sig;
  let cur = [];
  try { cur = JSON.parse(localStorage.getItem(LOG) || '[]'); } catch { cur = []; }
  cur.push(row);
  localStorage.setItem(LOG, JSON.stringify(cur.slice(-400)));
}

export function readLog() {
  try { return JSON.parse(localStorage.getItem(LOG) || '[]'); } catch { return []; }
}

export function briefMarkdown(pins, scope) {
  const lines = ['# Client brief', '', `${scope.site} · week of ${scope.week} · ${scope.compare} · ${scope.segment} · ${scope.device}`, ''];
  for (const pin of pins.findings) {
    lines.push(`## ${pin.claim}`, '');
    for (const c of pin.caveats ?? []) lines.push(`- ${c}`);
    if (pin.link) lines.push('', pin.link);
    lines.push('');
  }
  if (pins.action) {
    lines.push('## Your recommendation', '', pins.action, '');
  }
  return lines.join('\n');
}

export function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
