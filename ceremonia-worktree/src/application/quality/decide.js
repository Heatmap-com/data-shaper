import { checkDecision } from '../../domain/quality/decisions.js';

/**
 * A decision record for one finding of a dataset's quality.json, checked
 * as the site's quality-decisions.json will read it.
 *
 * @param {{dataset: string, idsite: number, built: string, window: {start: string, end: string}, findings: Array<import('./screen.js').Finding>}} ledger
 * @param {string} findingId
 * @param {{decision: 'exclude' | 'include' | 'reprocess', params?: object | null, forRule?: boolean, datasetOnly?: boolean, by: string, note: string, today: string}} choice
 * @returns {import('../../domain/quality/decisions.js').Decision}
 */
export function decisionFor(ledger, findingId, choice) {
  const finding = ledger.findings.find((f) => f.id === findingId);
  if (!finding) {
    const ids = ledger.findings.map((f) => f.id);
    throw new Error(`no finding ${findingId} in dataset ${ledger.dataset}${ids.length > 0 ? ` (${ids.join(', ')})` : '; it has no findings'}`);
  }
  if (choice.decision === 'reprocess' && choice.forRule) throw new Error('a reprocess patches the screen for every finding already; --for-rule is for exclude and include');
  const forRule = choice.decision !== 'reprocess' && Boolean(choice.forRule);
  return checkDecision({
    rule: finding.screen,
    decision: choice.decision,
    applies: forRule ? 'rule' : 'finding',
    finding: finding.id,
    members: forRule || choice.decision === 'reprocess' ? [] : finding.members,
    dataset: choice.datasetOnly ? ledger.dataset : null,
    params: choice.decision === 'reprocess' ? choice.params ?? null : null,
    by: choice.by,
    at: choice.today,
    note: choice.note,
    evidence: {
      dataset: ledger.dataset,
      screened: ledger.built,
      window: ledger.window,
      label: finding.label,
      question: finding.question,
      status: finding.status,
      applied: finding.disposition,
      members: finding.members.length,
      impact: finding.impact,
    },
  }, `decision on ${finding.id}`);
}

/**
 * The site's decisions file with one more decision, last so it wins.
 * @param {{idsite: number, decisions: object[]} | null} current
 * @param {number} idsite
 * @param {import('../../domain/quality/decisions.js').Decision} decision
 */
export function withDecision(current, idsite, decision) {
  if (current && current.idsite !== idsite) throw new Error(`the decisions file is for idsite ${current.idsite}, not ${idsite}`);
  return { idsite, decisions: [...(current?.decisions ?? []), decision] };
}
