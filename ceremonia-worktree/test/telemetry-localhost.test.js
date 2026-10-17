import { describe, expect, it } from 'vitest';
import { createLocalhostTelemetry, summarize } from '../src/adapters/telemetry/localhost.js';

describe('localhost telemetry', () => {
  it('serves a summary of slow and failed queries on 127.0.0.1', async () => {
    const telemetry = createLocalhostTelemetry({ port: 0 });
    const address = await telemetry.start();
    expect(address.host).toBe('127.0.0.1');
    telemetry.emit({ name: 'query', durationMs: 12000, ok: true, attrs: { label: 'audit:H1', rows: 40, idsite: 5795 } });
    telemetry.emit({ name: 'query', durationMs: 800, ok: false, attrs: { label: 'audit:F3', error: 'timeout' } });
    telemetry.emit({ name: 'stage', durationMs: 20000, ok: true, attrs: { stage: 'funnel', brand: 'dvf', idsite: 5795 } });

    const summary = await fetch(`http://127.0.0.1:${address.port}/telemetry/summary`).then((res) => res.json());
    expect(summary.queryFailures).toBe(1);
    expect(summary.attention.map((row) => row.label).sort()).toEqual(['audit:F3', 'audit:H1']);
    expect(summary.slowest[0].label).toBe('audit:H1');
    expect(summary.stages[0].stage).toBe('funnel');

    const health = await fetch(`http://127.0.0.1:${address.port}/health`).then((res) => res.json());
    expect(health.ok).toBe(true);
    await telemetry.close();
  });

  it('serves on a free port when another engine process holds the configured one', async () => {
    const first = createLocalhostTelemetry({ port: 0 });
    const held = await first.start();
    const second = createLocalhostTelemetry({ port: held.port });
    const address = await second.start();
    expect(address.port).not.toBe(held.port);
    const health = await fetch(`http://127.0.0.1:${address.port}/health`).then((res) => res.json());
    expect(health.ok).toBe(true);
    await second.close();
    await first.close();
  });

  it('ranks labels by time spent', () => {
    const summary = summarize([
      { name: 'query', durationMs: 100, ok: true, attrs: { label: 'audit:F1', rows: 10 } },
      { name: 'query', durationMs: 9000, ok: true, attrs: { label: 'audit:P6', rows: 2 } },
      { name: 'query', durationMs: 4000, ok: true, attrs: { label: 'audit:P6', rows: 2 } },
    ]);
    expect(summary.slowest[0]).toMatchObject({ label: 'audit:P6', calls: 2, durationMs: 13000, maxMs: 9000 });
    expect(summary.attention.map((row) => row.label)).toEqual(['audit:P6']);
  });
});
