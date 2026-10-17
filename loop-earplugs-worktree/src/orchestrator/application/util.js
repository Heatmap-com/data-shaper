/** Resolves after ms, or rejects early when the signal aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Readable unique job id: `<slug>-20261013-071530-<rand4>`. */
export function newJobId(now, slug, random = Math.random) {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`;
  const rand = Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0');
  return `${slug}-${stamp}-${rand}`;
}
