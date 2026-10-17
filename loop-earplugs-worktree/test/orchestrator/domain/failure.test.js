import { describe, expect, it } from 'vitest';
import { agentUnavailable, classifyFailure, describeFailure } from '../../../src/orchestrator/domain/failure.js';

const rules = [
  { match: 'ENOTFOUND|net::ERR_CONNECTION_REFUSED', class: 'transient', reason: 'merchant site not reachable' },
  { match: 'login required|password protected', class: 'blocked', reason: 'login wall' },
];

describe('agentUnavailable', () => {
  it('matches a provider usage-limit message', () => {
    expect(agentUnavailable({ finalText: "403 You've reached your monthly usage limit for this billing cycle. Your quota will be refreshed in the next cycle." })).toBe(true);
  });

  it('does not match an ordinary failure', () => {
    expect(agentUnavailable({ finalText: 'exit 1: names.json missing' })).toBe(false);
  });

  it('does not match the result contract echoed into a transcript', () => {
    const echoed = 'A usage limit on your own account is `blocked` too: say which account and when it refreshes.';
    expect(agentUnavailable({ finalText: 'Done. The naming stage is complete.', tail: echoed })).toBe(false);
  });

  it('matches a 429 quota error in the raw tail', () => {
    expect(agentUnavailable({ finalText: '', tail: 'provider_error: 429 Too Many Requests: quota exceeded' })).toBe(true);
  });
});

describe('classifyFailure', () => {
  it('classifies a transient rule', () => {
    expect(classifyFailure(rules, { kind: 'handler', message: 'getaddrinfo ENOTFOUND shop.example' }))
      .toEqual({ class: 'transient', reason: 'merchant site not reachable' });
  });

  it('classifies a blocked rule', () => {
    expect(classifyFailure(rules, { kind: 'handler', message: 'Login required to continue' }))
      .toEqual({ class: 'blocked', reason: 'login wall' });
  });

  it('matches case-insensitively against the log tail too', () => {
    expect(classifyFailure(rules, { kind: 'handler', message: 'exit 1', logTail: 'PASSWORD PROTECTED area' }))
      .toEqual({ class: 'blocked', reason: 'login wall' });
  });

  it('lets the first matching rule win', () => {
    const ordered = [
      { match: 'boom', class: 'blocked', reason: 'first' },
      { match: 'boom', class: 'transient', reason: 'second' },
    ];
    expect(classifyFailure(ordered, { kind: 'handler', message: 'boom' })).toEqual({ class: 'blocked', reason: 'first' });
  });

  it('treats an unmatched failure as a defect with its message', () => {
    expect(classifyFailure(rules, { kind: 'handler', message: 'segfault' }))
      .toEqual({ class: 'defect', reason: 'segfault' });
  });

  it('treats a timeout as a defect', () => {
    expect(classifyFailure(rules, { kind: 'handler', message: 'killed', timedOut: true }))
      .toEqual({ class: 'defect', reason: 'timed out' });
  });

  it('falls back to a generic reason with no rules and no message', () => {
    expect(classifyFailure(undefined, { kind: 'check', message: '' }))
      .toEqual({ class: 'defect', reason: 'stage failed' });
  });
});

describe('describeFailure', () => {
  it('summarizes the failure with check details', () => {
    const failure = {
      kind: 'check',
      message: 'not complete',
      details: [
        { name: 'manifest', ok: true },
        { name: 'dataset', ok: false, message: 'missing rows' },
      ],
    };
    const verdict = { class: 'defect', reason: 'not complete' };
    expect(describeFailure(failure, verdict)).toEqual({
      kind: 'check',
      message: 'not complete',
      command: '(none)',
      exit: '(none)',
      timedOut: false,
      logTail: '(no output)',
      check: 'ok manifest\nFAIL dataset — missing rows',
      class: 'defect',
      reason: 'not complete',
    });
  });
});
