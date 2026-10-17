/** Exponential backoff with jitter. `attempt` is 1 for the first retry. */
export function backoffMs(policy = {}, attempt, random = Math.random) {
  const base = policy.backoffMs ?? 30_000;
  const factor = policy.factor ?? 2;
  const max = policy.maxBackoffMs ?? 600_000;
  const jitter = policy.jitter ?? 0.2;
  const raw = Math.min(max, base * factor ** Math.max(0, attempt - 1));
  return Math.round(raw * (1 - jitter + random() * 2 * jitter));
}
