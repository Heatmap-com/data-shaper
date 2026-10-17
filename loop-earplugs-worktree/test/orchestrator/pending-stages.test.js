import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adapter as pendingHandler } from '../../src/orchestrator/adapters/handlers/pending.js';
import { adapter as pendingCheck } from '../../src/orchestrator/adapters/checks/pending.js';
import { classifyFailure } from '../../src/orchestrator/domain/failure.js';

const stagesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../orchestration/stages');

async function stages() {
  const names = (await readdir(stagesDir)).filter((name) => name.endsWith('.stage.json'));
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(stagesDir, name), 'utf8'))));
}

describe('library stages', () => {
  it('every stage declares a handler and a completion check', async () => {
    for (const stage of await stages()) {
      expect(stage.handler?.use, stage.id).toBeTruthy();
      expect(stage.check?.use, stage.id).toBeTruthy();
    }
  });

  it('a pending stage is never complete and stops the job as blocked', async () => {
    const pending = (await stages()).filter((stage) => stage.handler.use === 'pending');
    expect(pending.length).toBeGreaterThan(0);
    for (const stage of pending) {
      expect((await pendingCheck.evaluate({}, stage.check)).ok).toBe(false);
      const result = await pendingHandler.run({}, stage.handler);
      const verdict = classifyFailure(stage.errors, { kind: 'handler', message: result.message });
      expect(verdict, stage.id).toEqual({ class: 'blocked', reason: 'this stage lands in a later phase' });
    }
  });
});
