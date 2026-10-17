import { describe, expect, it } from 'vitest';
import { backoffMs } from '../../../src/orchestrator/domain/retry.js';

describe('backoffMs', () => {
  it('grows the base exponentially by attempt', () => {
    const policy = { backoffMs: 1000, factor: 2, jitter: 0 };
    expect(backoffMs(policy, 1)).toBe(1000);
    expect(backoffMs(policy, 2)).toBe(2000);
    expect(backoffMs(policy, 3)).toBe(4000);
  });

  it('caps at maxBackoffMs', () => {
    const policy = { backoffMs: 1000, factor: 2, maxBackoffMs: 5000, jitter: 0 };
    expect(backoffMs(policy, 10)).toBe(5000);
  });

  it('uses defaults when the policy is empty', () => {
    expect(backoffMs({}, 1, () => 0.5)).toBe(30_000);
  });

  it('applies jitter around the base', () => {
    const policy = { backoffMs: 1000, factor: 2, jitter: 0.2 };
    expect(backoffMs(policy, 2, () => 0)).toBe(1600);
    expect(backoffMs(policy, 2, () => 1)).toBe(2400);
    expect(backoffMs(policy, 2, () => 0.5)).toBe(2000);
  });

  it('stays within the jitter bounds for sampled randoms', () => {
    const policy = { backoffMs: 1000, factor: 2, jitter: 0.2 };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const raw = 1000 * 2 ** (attempt - 1);
      for (const random of [0.01, 0.37, 0.99]) {
        const ms = backoffMs(policy, attempt, () => random);
        expect(ms).toBeGreaterThanOrEqual(Math.round(raw * 0.8));
        expect(ms).toBeLessThanOrEqual(Math.round(raw * 1.2));
      }
    }
  });
});
