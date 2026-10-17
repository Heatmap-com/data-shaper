import { describe, expect, it } from 'vitest';
import { createHarvester } from '../src/capture/harvester.js';

/**
 * The HarvestPort the capture and naming consumers share: the bot runs
 * only when a command is configured, and the names always come from the
 * artifact loader, after the bot.
 */

const JOB = { idsite: 7, idsitehsr: 9, url: 'https://shop.example/pages/lp' };
const logger = { info() {} };

function recorder() {
  const calls = [];
  return {
    calls,
    botRunner: { run: async (job, naming) => { calls.push(['bot', job.idsitehsr, naming.command]); } },
    artifacts: { readNames: async (job) => { calls.push(['read', job.idsitehsr]); return [{ name: 'Hero' }]; } },
  };
}

describe('createHarvester', () => {
  it('runs the configured bot, then reads its names', async () => {
    const { calls, botRunner, artifacts } = recorder();
    const rows = await createHarvester({ botRunner, artifacts }).harvestNames(JOB, { command: 'bot {url}' }, logger);
    expect(rows).toEqual([{ name: 'Hero' }]);
    expect(calls).toEqual([['bot', 9, 'bot {url}'], ['read', 9]]);
  });

  it('reads the artifact directly when no command is configured', async () => {
    const { calls, botRunner, artifacts } = recorder();
    await createHarvester({ botRunner, artifacts }).harvestNames(JOB, { command: '' }, logger);
    expect(calls).toEqual([['read', 9]]);
  });

  it('reads names.json from disk by default and names a missing root', async () => {
    const harvester = createHarvester({ botRunner: { run: async () => {} } });
    await expect(harvester.harvestNames(JOB, {}, logger)).rejects.toThrow('no naming command configured and no datasetRoot to read names.json from');
  });
});
