import { fileArtifacts } from './artifacts.js';

/**
 * The HarvestPort over a bot runner and the artifact files. Without a
 * configured command it reads the artifact directly, which is how a
 * consumer driven by an external harvest run works.
 *
 * @param {{botRunner: import('./bot-runner.js').BotRunner, artifacts?: import('./artifacts.js').ArtifactLoader}} deps
 * @returns {import('../ports/harvest.js').HarvestPort}
 */
export function createHarvester({ botRunner, artifacts = fileArtifacts }) {
  return {
    async harvestNames(job, naming, logger) {
      if (naming.command) await botRunner.run(job, naming, logger);
      return artifacts.readNames(job, naming);
    },
  };
}
