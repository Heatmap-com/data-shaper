import { checkParams } from '../_lib/quality-params.js';

const SHARE = { type: 'number', min: 0, max: 1, nullable: true };
const SPEC = {
  ask: {
    type: 'object',
    keys: { sessionShare: SHARE, orderShare: SHARE, revenueShare: SHARE, buyerShare: SHARE, conversionShift: SHARE, aovShift: SHARE },
  },
  maxAutoMembers: { type: 'number', min: 0, integer: true, nullable: true },
};

const WORDS = {
  sessionShare: 'its share of sessions',
  orderShare: 'its share of orders',
  revenueShare: 'its share of revenue',
  buyerShare: 'its share of buyers',
  conversionShift: 'the change it makes to conversion',
  aovShift: 'the change it makes to AOV',
};

/** Relative change from `before` to `after`, or null when either is missing. */
const shift = (before, after) => (before !== null && before !== undefined && after !== null && after !== undefined && before !== 0 ? Math.abs(after - before) / before : null);

/** @type {import('../../ports/quality.js').QualityTriageAdapter} */
export const adapter = {
  id: 'impact',
  defaults: Object.freeze({
    ask: Object.freeze({ sessionShare: 0.01, orderShare: 0.01, revenueShare: 0.01, buyerShare: 0.01, conversionShift: 0.02, aovShift: 0.02 }),
    maxAutoMembers: null,
  }),

  check(params) {
    return checkParams(params, SPEC);
  },

  triage({ candidate, impact, params }) {
    const bars = /** @type {Record<string, number | null>} */ (params.ask);
    const moved = {
      sessionShare: impact.sessionShare ?? null,
      orderShare: impact.orderShare,
      revenueShare: impact.revenueShare,
      buyerShare: impact.buyerShare ?? null,
      conversionShift: shift(impact.conversionWith, impact.conversionWithout),
      aovShift: shift(impact.aovWith, impact.aovWithout),
    };
    const crossed = Object.entries(bars)
      .filter(([name, bar]) => bar !== null && moved[name] !== null && moved[name] !== undefined && moved[name] >= bar)
      .map(([name, bar]) => `${WORDS[name]}, ${(moved[name] * 100).toFixed(2)}%, is at or over the ${(bar * 100).toFixed(2)}% bar (ask.${name})`);
    const maxAuto = /** @type {number | null} */ (params.maxAutoMembers);
    if (maxAuto !== null && candidate.members.length > maxAuto) crossed.push(`${candidate.members.length} members, over the ${maxAuto} decided without a person`);
    return crossed.length > 0
      ? { ask: true, why: crossed.join('; ') }
      : { ask: false, why: 'every declared share and shift is under its bar' };
  },
};
