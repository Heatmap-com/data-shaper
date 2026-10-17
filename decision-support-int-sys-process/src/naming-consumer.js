import { mapNameRows } from './naming-mapper.js';

/**
 * The v1 naming consumer (NAMING-BEFORE-ANALYSIS.md "Consumer"), kept for
 * compatibility until cutover: N agents poll naming_queue, claim rows
 * token-exclusively, run the naming bot as an external command, map the
 * harvested NameRows onto the taxonomy, and call completeNaming — the v1
 * port. The bot run and names.json read come through the same HarvestPort
 * the capture consumer uses; src/capture-consumer.js's runCaptureAgents is
 * the schema-2 successor on the ae_capture_queue port.
 *
 * @deprecated Plan R4.3. deploy/analysis-naming.service runs it through
 * `src/index.js --naming-agents 1` until phase 5 retires the v1 path.
 */

/**
 * @param {object} opts
 * @param {import('./ports/persistence/naming-queue.js').NamingQueue} opts.persistence
 * @param {import('./config.js')} opts.config
 * @param {object} opts.logger
 * @param {import('./ports/dataset.js').Clock} opts.clock
 * @param {import('./ports/harvest.js').HarvestPort} opts.harvester
 */
export async function runNamingAgents({ persistence, config, logger, clock, harvester }) {
  const count = Math.max(1, config.agents.naming);
  logger.info({ agents: count }, 'naming consumer started');

  async function agent(agentIndex) {
    for (;;) {
      const job = await persistence.claimNaming();
      if (!job) return;
      const started = Date.now();
      logger.info({ agent: agentIndex, idsite: job.idsite, idsitehsr: job.idsitehsr, url: job.url }, 'naming claimed');
      try {
        const rows = await harvester.harvestNames(job, config.naming, logger);
        const names = mapNameRows(rows, { pageUrl: job.url });
        await persistence.completeNaming({
          idsite: job.idsite,
          idsitehsr: job.idsitehsr,
          url: job.url,
          namedOn: clock.todayUtc(),
          names,
        });
        logger.info(
          { agent: agentIndex, idsite: job.idsite, idsitehsr: job.idsitehsr, harvested: rows.length, named: names.length, seconds: (Date.now() - started) / 1000 },
          'naming complete',
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error({ agent: agentIndex, idsite: job.idsite, idsitehsr: job.idsitehsr, err }, 'naming failed');
        await persistence.failNaming({ idsite: job.idsite, idsitehsr: job.idsitehsr, reason });
      }
    }
  }

  await Promise.all(Array.from({ length: count }, (_, i) => agent(i)));
  logger.info({ agents: count }, 'naming consumer drained');
}
