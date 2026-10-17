// Local interaction log for usability sessions. Never logs free text. Stays in this browser.
const KEY = 'qt:grok-k3:log';
const TASK = 'qt:grok-k3:task';

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}

export function log(type, detail = {}) {
  try {
    const entries = read();
    const p = new URLSearchParams(location.hash.slice(1));
    entries.push({ t: new Date().toISOString(), type, task: localStorage.getItem(TASK) ?? null, tab: p.get('tab'), ctx: p.get('ctx'), detail });
    localStorage.setItem(KEY, JSON.stringify(entries.slice(-5000)));
  } catch { /* storage full or blocked */ }
}

export function facilitatorPanel() {
  if (!new URLSearchParams(location.search).has('facilitator')) return;
  const box = document.createElement('div');
  box.className = 'facilitator';
  const status = document.createElement('span');
  const refresh = () => { status.textContent = `Task: ${localStorage.getItem(TASK) ?? '—'} · ${read().length} events`; };
  const button = (text, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', () => { fn(); refresh(); });
    return b;
  };
  box.append(
    status,
    button('Start next task', () => { const n = Number(localStorage.getItem(TASK) ?? 0) + 1; localStorage.setItem(TASK, String(n)); log('task_start', { n }); }),
    button('Stop task', () => { log('task_stop', { n: localStorage.getItem(TASK) }); }),
    button('Download log', () => {
      const blob = new Blob([JSON.stringify(read(), null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `grok-k3-log-${new Date().toISOString().slice(0, 19)}.json`;
      a.click();
    }),
    button('Clear', () => { localStorage.removeItem(KEY); localStorage.removeItem(TASK); }),
  );
  document.body.append(box);
  refresh();
}
