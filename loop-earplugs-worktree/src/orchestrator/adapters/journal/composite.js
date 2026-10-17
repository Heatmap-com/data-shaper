/**
 * Fans one record out to every journal. A failing write is logged, not thrown,
 * so a journal problem never fails a stage.
 *
 * @param {import('../../ports/journal.js').JournalPort[]} journals
 * @param {{warn?: (obj: object, msg: string) => void}} [logger]
 * @returns {import('../../ports/journal.js').JournalPort}
 */
export function createCompositeJournal(journals, logger = console) {
  return {
    async record(job, event) {
      for (const journal of journals) {
        try {
          await journal.record(job, event);
        } catch (err) {
          logger.warn({ err, job: job.id, type: event.type }, 'journal write failed');
        }
      }
    },
  };
}
