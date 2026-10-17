import { describe, expect, it, vi } from 'vitest';
import {
  attachConnectionRetry,
  isTransientConnectionError,
  withConnectionRetry,
} from '../src/connection-retry.js';

describe('connection retry', () => {
  it('recognizes a dropped socket and ignores a query error', () => {
    expect(isTransientConnectionError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(true);
    expect(isTransientConnectionError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientConnectionError(new Error('gateway refused query'))).toBe(false);
    const wrapped = new Error('Insert: HTTP request error');
    wrapped.cause = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(isTransientConnectionError(wrapped)).toBe(true);
  });

  it('retries a transient failure and then returns', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce('ok');
    const onRetry = vi.fn();
    await expect(withConnectionRetry(fn, { delaysMs: [0], onRetry })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-connection error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Code: 62. Syntax error'));
    await expect(withConnectionRetry(fn, { delaysMs: [0] })).rejects.toThrow(/Syntax error/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reruns a query whose body read is cut off', async () => {
    let calls = 0;
    const client = {
      async query() {
        calls += 1;
        if (calls === 1) {
          return { json: async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); } };
        }
        return { json: async () => [{ n: 1 }] };
      },
      async insert() {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      },
    };
    const wrapped = attachConnectionRetry(client, { info() {} }, { delaysMs: [0] });
    const rows = await (await wrapped.query({ query: 'select 1' })).json();
    expect(rows).toEqual([{ n: 1 }]);
    expect(calls).toBe(2);
    expect(attachConnectionRetry(client)).toBe(wrapped);
  });
});
