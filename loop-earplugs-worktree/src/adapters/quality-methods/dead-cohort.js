import { ratio } from '../../domain/quality/stats.js';
import { checkParams } from '../_lib/quality-params.js';

const SPEC = {
  minSessions: { type: 'number', min: 1, integer: true },
  minShare: { type: 'number', min: 0, max: 1 },
  maxConversionRatio: { type: 'number', min: 0, max: 1 },
  maxCheckoutRatio: { type: 'number', min: 0, max: 1 },
  minSiteBuyers: { type: 'number', min: 0, integer: true },
  ignore: { type: 'strings' },
};

/** @type {import('../../ports/quality.js').QualityMethodAdapter} */
export const adapter = {
  id: 'dead-cohort',
  subjects: ['groups'],
  defaults: Object.freeze({ minSessions: 1000, minShare: 0.01, maxConversionRatio: 0.1, maxCheckoutRatio: 0.2, minSiteBuyers: 20, ignore: [] }),

  check(params) {
    return checkParams(params, SPEC);
  },

  screen({ subject, rows, params, totals }) {
    const sessions = totals.sessions ?? 0;
    const buyers = totals.buyers ?? 0;
    const progressed = totals.progressed ?? 0;
    if (buyers < /** @type {number} */ (params.minSiteBuyers)) {
      return { candidates: [], stats: { rows: rows.length, sessions, buyers }, skipped: `${buyers} buying sessions on the site, under the ${params.minSiteBuyers} a rate comparison needs` };
    }
    const ignore = new Set(/** @type {string[]} */ (params.ignore));
    const candidates = [];
    for (const row of rows) {
      const key = String(row.key);
      if (ignore.has(key)) continue;
      const groupSessions = Number(row.sessions) || 0;
      const share = ratio(groupSessions, sessions) ?? 0;
      if (groupSessions < /** @type {number} */ (params.minSessions) || share < /** @type {number} */ (params.minShare)) continue;
      const restSessions = sessions - groupSessions;
      const conversion = ratio(Number(row.buyers) || 0, groupSessions) ?? 0;
      const checkout = ratio(Number(row.progressed) || 0, groupSessions) ?? 0;
      const restConversion = ratio(buyers - (Number(row.buyers) || 0), restSessions);
      const restCheckout = ratio(progressed - (Number(row.progressed) || 0), restSessions);
      if (restConversion === null || restConversion <= 0) continue;
      if (conversion > /** @type {number} */ (params.maxConversionRatio) * restConversion) continue;
      if (restCheckout !== null && restCheckout > 0 && checkout > /** @type {number} */ (params.maxCheckoutRatio) * restCheckout) continue;
      candidates.push({
        members: [key],
        label: `${subject.by} ${key === '' ? '(empty)' : key}`,
        reason: `${groupSessions} sessions (${(share * 100).toFixed(2)}% of the site) convert at ${(conversion * 100).toFixed(3)}% against ${(restConversion * 100).toFixed(3)}% for the rest`,
        values: {
          attribute: subject.by,
          value: key === '' ? '(empty)' : key,
          sessions: groupSessions,
          sessionShare: share,
          buyers: Number(row.buyers) || 0,
          orders: Number(row.orders) || 0,
          revenue: Number(row.revenue) || 0,
          progressed: Number(row.progressed) || 0,
          conversion,
          restConversion,
          checkoutRate: checkout,
          restCheckoutRate: restCheckout ?? 0,
        },
        units: {
          sessions: 'count', sessionShare: 'share', buyers: 'count', orders: 'count', revenue: 'money', progressed: 'count',
          conversion: 'share', restConversion: 'share', checkoutRate: 'share', restCheckoutRate: 'share',
        },
      });
    }
    return { candidates, stats: { rows: rows.length, sessions, buyers, progressed } };
  },
};
