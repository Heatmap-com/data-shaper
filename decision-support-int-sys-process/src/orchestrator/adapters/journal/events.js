/**
 * Writes the whole event to the store's events table.
 *
 * @param {import('../../ports/event-log.js').EventLogPort} events
 * @returns {import('../../ports/journal.js').JournalPort}
 */
export function createEventsJournal(events) {
  return {
    async record(job, event) {
      await events.append(job.id, { at: new Date().toISOString(), ...event });
    },
  };
}
