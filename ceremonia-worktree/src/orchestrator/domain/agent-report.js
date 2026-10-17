const STATUSES = new Set(['fixed', 'blocked', 'gave_up']);

/**
 * The result.json an agent writes before it stops (system/result-contract.md),
 * read defensively: an unknown status is `gave_up`, and a missing or unreadable
 * file is `written: false`.
 *
 * @param {unknown} body parsed JSON, or undefined when there was none
 * @returns {{written: boolean, status: 'fixed'|'blocked'|'gave_up', summary: string, blocker: string, changes: unknown[]}}
 */
export function parseAgentReport(body) {
  if (!body || typeof body !== 'object') return { written: false, status: 'gave_up', summary: 'no result.json was written', blocker: '', changes: [] };
  const status = STATUSES.has(body.status) ? body.status : 'gave_up';
  return { written: true, status, summary: String(body.summary ?? ''), blocker: String(body.blocker ?? ''), changes: Array.isArray(body.changes) ? body.changes : [] };
}
