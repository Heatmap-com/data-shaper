/**
 * @typedef {Object} Failure
 * @property {'handler'|'check'|'agent'} kind
 * @property {string} message
 * @property {string} [command]
 * @property {number|null} [exitCode]
 * @property {boolean} [timedOut]
 * @property {string} [logTail]
 * @property {import('../ports/completion-check.js').CheckDetail[]} [details]
 * @property {Verdict} [hint] the handler's own reading, used when no stage rule matches
 *
 * @typedef {{class: 'transient'|'blocked'|'defect', reason: string}} Verdict
 */

/**
 * A provider quota or billing stop. Retrying it spends attempts and fixes nothing.
 * It matches the provider's error wording only: transcripts echo the prompt, and
 * the prompt itself talks about usage limits.
 */
export function agentUnavailable(result) {
  const text = [result?.finalText, result?.tail].filter(Boolean).join('\n');
  return /reached (?:your|the) (?:monthly |daily )?usage limit|quota will be refreshed|\b(?:403|429)\b[^\n]*(?:usage limit|quota)/i.test(text);
}

/**
 * First matching stage rule wins, then the handler's hint. Anything else is a
 * defect, which goes to the fallback.
 */
export function classifyFailure(rules, failure) {
  const haystack = [failure.message, failure.logTail].filter(Boolean).join('\n');
  for (const rule of rules ?? []) {
    if (new RegExp(rule.match, 'i').test(haystack)) return { class: rule.class, reason: rule.reason ?? rule.match };
  }
  if (failure.hint?.class) return { class: failure.hint.class, reason: failure.hint.reason ?? failure.message };
  if (failure.timedOut) return { class: 'defect', reason: 'timed out' };
  return { class: 'defect', reason: failure.message || 'stage failed' };
}

export function describeFailure(failure, verdict) {
  return {
    kind: failure.kind,
    message: failure.message,
    command: failure.command ?? '(none)',
    exit: failure.exitCode ?? '(none)',
    timedOut: Boolean(failure.timedOut),
    logTail: failure.logTail || '(no output)',
    check: (failure.details ?? []).map((row) => `${row.ok ? 'ok' : 'FAIL'} ${row.name}${row.message ? ` — ${row.message}` : ''}`).join('\n') || '(not run)',
    class: verdict.class,
    reason: verdict.reason,
  };
}
