import { NAMING_MAX_AGE_DAYS, TAXONOMY_VERSION } from './taxonomy.js';

/**
 * A page is named recently when the latest record is complete, on the
 * current taxonomy version, and not older than maxAgeDays.
 *
 * @param {{status?: string, taxonomyVersion?: string, namedOn?: string} | null} record
 * @param {string} todayUtc YYYY-MM-DD
 * @param {number} [maxAgeDays]
 * @returns {{fresh: boolean, reason: string}}
 */
export function isNamingFresh(record, todayUtc, maxAgeDays = NAMING_MAX_AGE_DAYS) {
  if (!record || record.status !== 'complete') {
    return { fresh: false, reason: 'naming has not been completed for this page' };
  }
  if (record.taxonomyVersion !== TAXONOMY_VERSION) {
    return { fresh: false, reason: `naming taxonomy ${record.taxonomyVersion ?? 'unknown'} is not ${TAXONOMY_VERSION}` };
  }
  if (!record.namedOn) {
    return { fresh: false, reason: 'naming record has no date' };
  }
  const named = Date.parse(`${record.namedOn}T00:00:00Z`);
  const today = Date.parse(`${todayUtc}T00:00:00Z`);
  if (Number.isNaN(named) || Number.isNaN(today)) {
    return { fresh: false, reason: 'naming date is not a calendar day' };
  }
  const ageDays = Math.round((today - named) / 86400000);
  if (ageDays > maxAgeDays) {
    return { fresh: false, reason: `naming is ${ageDays} days old; max age is ${maxAgeDays}` };
  }
  return { fresh: true, reason: '' };
}
