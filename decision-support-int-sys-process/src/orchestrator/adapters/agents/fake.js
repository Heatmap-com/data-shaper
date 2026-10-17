import path from 'node:path';

/**
 * Test double for the coding-agent port. `behave(request)` is the test's agent:
 * it may write <runDir>/result.json and fix the fixture the stage checks.
 *
 * @param {object} descriptor
 * @param {{ behave?: (request: import('../../ports/coding-agent.js').AgentRunRequest) => Promise<void | {finalText?: string|null, tail?: string, exitCode?: number}> }} [deps]
 * @returns {import('../../ports/coding-agent.js').CodingAgentPort}
 */
export function createAgent(descriptor, { behave } = {}) {
  return {
    id: descriptor.id ?? 'fake',
    async run(request) {
      const started = Date.now();
      const extra = await behave?.(request);
      return {
        exitCode: extra?.exitCode ?? 0,
        timedOut: false,
        aborted: false,
        finalText: extra && 'finalText' in extra ? extra.finalText : 'fake',
        tail: extra?.tail ?? '',
        transcriptFile: path.join(request.runDir, 'transcript.jsonl'),
        durationMs: Date.now() - started,
      };
    },
  };
}
