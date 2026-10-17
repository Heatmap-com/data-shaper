import { describe, expect, it } from 'vitest';
import { CriteriaError, criteriaSchemaErrors, parseCriteria, resolveCriteria, schemaErrors, valueErrors } from '../../src/domain/criteria.js';
import { SUBJECT_TYPES, isPageShaped, subjectKey } from '../../src/domain/subject-types.js';

const SCHEMA = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['active', 'ended', 'all'] },
    minAssignedVisits: { type: 'integer', minimum: 0 },
    experiment: { type: 'string' },
    share: { type: 'number' },
    auto: { type: 'boolean' },
    kinds: { type: 'array', items: { type: 'string' } },
  },
  required: ['state'],
  additionalProperties: false,
};

describe('criteria schemas', () => {
  it('accepts the subset and names what falls outside it', () => {
    expect(criteriaSchemaErrors(SCHEMA, 'x')).toEqual([]);
    expect(schemaErrors({ type: 'object', properties: { a: { type: 'string', pattern: '^a' } } }, 'x')).toEqual(['x.a: unsupported keyword "pattern"']);
    expect(schemaErrors({ type: 'list' }, 'x')).toEqual(['x: type must be one of object, array, string, integer, number, boolean']);
    expect(schemaErrors({ type: 'array' }, 'x')).toEqual(['x: an array needs items']);
    expect(schemaErrors({ type: 'object', properties: {}, required: ['b'] }, 'x')).toEqual(['x: required "b" is not a property']);
    expect(schemaErrors({ type: 'object', additionalProperties: true }, 'x')).toEqual(['x: additionalProperties may only be false']);
    expect(criteriaSchemaErrors({ type: 'string' }, 'x')).toEqual(['x: criteria schema must be an object']);
    expect(criteriaSchemaErrors({ type: 'object', properties: {} }, 'x')).toEqual(['x: criteria schema needs additionalProperties: false']);
  });
});

describe('criteria values', () => {
  it('names every way a value breaks the schema', () => {
    expect(valueErrors({ state: 'active', minAssignedVisits: 500, kinds: ['a'], share: 0.5, auto: true }, SCHEMA)).toEqual([]);
    expect(valueErrors({ state: 'paused', minAssignedVisits: -1, kinds: [3], share: 'x', auto: 1, extra: 1 }, SCHEMA)).toEqual([
      'criteria.state must be one of "active", "ended", "all"',
      'criteria.minAssignedVisits must be at least 0',
      'criteria.kinds[0] must be a string',
      'criteria.share must be a number',
      'criteria.auto must be a boolean',
      'criteria.extra is not a criterion; known: state, minAssignedVisits, experiment, share, auto, kinds',
    ]);
    expect(valueErrors({}, SCHEMA)).toEqual(['criteria.state is required']);
    expect(valueErrors({ state: 'all', minAssignedVisits: 1.5 }, SCHEMA)).toEqual(['criteria.minAssignedVisits must be an integer']);
    expect(valueErrors([], SCHEMA)).toEqual(['criteria must be an object']);
  });

  it('merges the given criteria over the defaults and throws on a violation', () => {
    expect(resolveCriteria(SCHEMA, { state: 'active', minAssignedVisits: 500 }, { minAssignedVisits: 50 })).toEqual({ state: 'active', minAssignedVisits: 50 });
    expect(() => resolveCriteria(SCHEMA, { state: 'active' }, { state: 'paused' })).toThrow(CriteriaError);
    expect(() => resolveCriteria(SCHEMA, {}, [])).toThrow(/criteria must be a JSON object/);
    try {
      resolveCriteria(SCHEMA, {}, { minAssignedVisits: 'many' });
    } catch (error) {
      expect(error.errors).toEqual(['criteria.state is required', 'criteria.minAssignedVisits must be an integer']);
    }
  });

  it('parses --select text', () => {
    expect(parseCriteria(undefined)).toEqual({});
    expect(parseCriteria('true')).toEqual({});
    expect(parseCriteria('{"state":"ended"}')).toEqual({ state: 'ended' });
    expect(() => parseCriteria('{state:ended}')).toThrow(/--select is not JSON/);
  });
});

describe('subject types', () => {
  it('keys a page by its idsitehsr and other types by a prefixed key', () => {
    expect(subjectKey('page', 222)).toBe('222');
    expect(subjectKey('quiz', '9')).toBe('9');
    expect(subjectKey('experiment', 'kameleoon:12345')).toBe('exp:kameleoon:12345');
    expect(subjectKey('experiment', 'exp:kameleoon:12345')).toBe('exp:kameleoon:12345');
    expect(subjectKey('funnel', 'checkout')).toBe('fn:checkout');
    expect(subjectKey('journey', 'home>pdp')).toBe('jr:home>pdp');
    expect(() => subjectKey('widget', 1)).toThrow(/unknown subject type "widget"/);
    expect(() => subjectKey('funnel', '')).toThrow(/empty/);
  });

  it('is frozen, and page-shaped types are the idsitehsr-keyed ones', () => {
    expect(Object.isFrozen(SUBJECT_TYPES.page)).toBe(true);
    expect(Object.keys(SUBJECT_TYPES).filter(isPageShaped)).toEqual(['page', 'quiz']);
  });
});
