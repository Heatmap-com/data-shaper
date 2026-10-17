import { checkParams } from '../_lib/quality-params.js';

/** @type {import('../../ports/quality.js').QualityTriageAdapter} */
export const adapter = {
  id: 'always-ask',
  defaults: Object.freeze({}),

  check(params) {
    return checkParams(params, {});
  },

  triage() {
    return { ask: true, why: 'this screen asks a person about every finding' };
  },
};
