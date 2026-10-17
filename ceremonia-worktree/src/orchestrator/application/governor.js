import { capacityOf, capacityProblem, resourceKey } from '../domain/capacity.js';

/** Holds every named resource for the length of `fn`, in sorted order so two holders cannot deadlock. */
export function createGovernor({ resources, capacity, leaseMs, sleep, pollMs = 2000, host = 'local' }) {
  return {
    async withResources(names, owner, signal, fn) {
      const held = [];
      try {
        for (const name of [...new Set(names)].sort()) {
          const problem = capacityProblem(capacity[name]);
          if (problem) throw new Error(`resource "${name}" ${problem} in governor.capacity`);
          const entry = capacityOf(capacity[name]);
          const key = resourceKey(name, entry, host);
          let slot = null;
          while (!(slot = await resources.tryAcquire(key, entry.limit, owner, leaseMs))) {
            if (signal?.aborted) throw signal.reason ?? new Error('aborted');
            await sleep(pollMs, signal);
          }
          let renewing = false;
          const renew = setInterval(() => {
            if (renewing) return;
            renewing = true;
            resources.renew(key, slot.token, leaseMs).catch(() => {}).finally(() => { renewing = false; });
          }, Math.floor(leaseMs / 3));
          held.push({ key, slot, renew });
        }
        return await fn();
      } finally {
        for (const { key, slot, renew } of held.reverse()) {
          clearInterval(renew);
          await resources.release(key, slot.token).catch(() => {});
        }
      }
    },
  };
}
