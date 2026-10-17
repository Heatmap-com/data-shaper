import { describe, expect, it } from 'vitest';
import { createValidator } from '../../src/orchestrator/domain/validate.js';
import { RESILIENCE, makeJob, makeStage } from './orch-test-helpers.js';

const known = (ids) => ({ get: async (id) => (ids.includes(id) ? { id } : null) });

function validator({ capacity = { chromium: 1 }, checks = known(['fake-check']), values = {} } = {}) {
  return createValidator({
    descriptors: { resilience: async () => RESILIENCE, agent: async (id) => { if (id !== 'fake') throw new Error('none'); return { id }; } },
    prompts: { sources: async () => ['test.md'] },
    handlers: known(['fake-handler']),
    checks,
    capacity,
    values,
  });
}

describe('validateJob', () => {
  it('accepts a well-formed job', async () => {
    expect(await validator().validateJob(makeJob())).toEqual([]);
  });

  it('rejects an unknown resilience level', async () => {
    const problems = await validator().validateJob(makeJob({ resilience: 'heroic' }));
    expect(problems).toEqual([expect.stringMatching(/resilience "heroic" is not in general\/resilience.json/)]);
  });

  it('rejects a stage with no completion check or no handler', async () => {
    const stage = makeStage({ check: undefined, handler: undefined });
    const problems = await validator().validateJob(makeJob({ stages: [stage] }));
    expect(problems).toContain('stage naming: no handler');
    expect(problems).toContain('stage naming: no completion check');
  });

  it('rejects an error rule with a bad regex or class', async () => {
    const stage = makeStage({ errors: [{ match: '(unclosed', class: 'transient' }, { match: 'ok', class: 'flaky' }] });
    const problems = await validator().validateJob(makeJob({ stages: [stage] }));
    expect(problems).toEqual([
      expect.stringMatching(/errors\[0\] match is not a valid regex/),
      expect.stringMatching(/errors\[1\] class "flaky" is not one of transient, blocked, defect/),
    ]);
  });

  it('rejects a fallback on a stage with no skill or no prompt', async () => {
    const stage = makeStage({ fallback: { agent: 'fake' } });
    const problems = await validator().validateJob(makeJob({ stages: [stage] }));
    expect(problems).toEqual([
      "stage naming: a fallback needs the stage's skill, which its prompt hands to the agent",
      'stage naming: fallback has no prompt',
    ]);
  });

  it('rejects a resource with no capacity', async () => {
    const stage = makeStage({ skill: 'skills/x/SKILL.md', resources: ['chromium'], fallback: { agent: 'fake', prompt: 'fallback/test.md', resources: ['clickhouse-heavy'] } });
    const problems = await validator().validateJob(makeJob({ stages: [stage] }));
    expect(problems).toEqual(['stage naming: resource "clickhouse-heavy" has no capacity in the config\'s governor.capacity']);
  });

  it('rejects a misspelled resource scope', async () => {
    const stage = makeStage({ skill: 'skills/x/SKILL.md', resources: ['chromium'] });
    const problems = await validator({ capacity: { chromium: { limit: 1, scope: 'host' } } }).validateJob(makeJob({ stages: [stage] }));
    expect(problems).toEqual(['stage naming: resource "chromium" has scope "host"; use machine or cluster in the config\'s governor.capacity']);
  });

  it('rejects {{site.*}} and {{config.*}} references with no value', async () => {
    const stage = makeStage({ handler: { use: 'fake-handler', args: ['{{site.name}}', '{{config.report.chromePath}}', '{{config.naming.botDir}}', '{{unit.page.url}}'] } });
    const problems = await validator({ values: { naming: { botDir: '/bot' } } }).validateJob(makeJob({ stages: [stage] }));
    expect(problems).toEqual([
      'stage naming: templates reference {{site.name}} but acme has no name',
      'stage naming: templates reference {{config.report.chromePath}} but the config has no values.report.chromePath',
    ]);
  });

  it('reports what a check finds wrong with its own spec', async () => {
    const checks = { get: async (id) => (id === 'fake-check' ? { id, validate: (spec) => (spec.file ? [] : ['needs file']) } : null) };
    const problems = await validator({ checks }).validateJob(makeJob());
    expect(problems).toEqual(['stage naming: check fake-check: needs file']);
  });

  it('rejects a chart with no type, and one declared by two stages', async () => {
    const stages = [
      makeStage({ id: 'one', charts: { 'fig-a': { type: 'daily-orders' } } }),
      makeStage({ id: 'two', charts: { 'fig-a': { type: 'weekly-revenue' }, 'fig-b': {} } }),
    ];
    const problems = await validator().validateJob(makeJob({ stages }));
    expect(problems).toEqual(['stage two: chart "fig-a" is also declared by stage one', 'stage two: chart "fig-b" needs a type']);
  });
});
