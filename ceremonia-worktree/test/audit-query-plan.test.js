import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compareCheckout, shapeAcquisition } from '../src/audit/shape.js';
import { funnelAcquisitionQueries, pathTrendQuery } from '../src/audit/queries/funnel.js';
import { templateAcquisitionQueries } from '../src/audit/queries/template.js';
import { contextAcquisitionQueries } from '../src/audit/queries/context.js';
import { REQUIRED_CLASSES } from '../src/audit/element-classes.js';
import { auditWindows } from '../src/audit/windows.js';
import { matrixCoverageQuery, readinessQueries } from '../src/audit/queries/readiness.js';
import { funnelChannelQuery, funnelSnapshotQuery, funnelWeeklyQuery, siteKpiQuery } from '../src/audit/queries/funnel.js';
import { elementScorecardQuery, templateWeeklyQuery } from '../src/audit/queries/template.js';

const windows = auditWindows('2026-10-06');
const rules = [
  { pattern: '^/$', template: 'home' },
  { pattern: '^/collections/[^/]+$', template: 'plp' },
  { pattern: '/products/', template: 'pdp' },
  { pattern: '^/cart', template: 'cart_page' },
];
const scope = {
  byTemplate: { home: [11], plp: [22], pdp: [33], cart_page: [44], checkout: [55], search: [66] },
};
const entries = Object.entries(REQUIRED_CLASSES).flatMap(([template, classes]) =>
  classes.map((elementClass, i) => ({
    idsite: 9,
    template,
    element_class: elementClass,
    element_name: elementClass,
    selector_match: `div\\.${elementClass.replace('.', '-')}`,
    position: i % 3 === 0 ? i + 1 : null,
    valid_from: '2024-01-01',
    valid_to: '2099-12-31',
    absent: false,
  })));

/**
 * The SQL is pinned by a digest of its whitespace-collapsed text.
 * @param {Array<{id: string, label: string, sql: string, params: object, chunkDays?: number}>} queries
 */
function plan(queries) {
  return queries.map(({ sql, ...rest }) => ({
    ...rest,
    sql: createHash('sha256').update(sql.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 24),
  }));
}

describe('audit query plan characterization', () => {
  it('keeps every funnel, template, and context query, scoped and unscoped', () => {
    expect({
      funnel: plan(funnelAcquisitionQueries(9, windows, rules)),
      funnelScoped: plan(funnelAcquisitionQueries(9, windows, rules, scope)),
      pathTrend: plan([pathTrendQuery(9, windows, rules, ['home > plp > pdp', 'pdp'], [11, 22, 33])]),
      pathTrendEmpty: pathTrendQuery(9, windows, rules, []),
      template: plan(templateAcquisitionQueries(9, windows, rules, entries, true)),
      templateScoped: plan(templateAcquisitionQueries(9, windows, rules, entries, false, scope)),
      context: plan(contextAcquisitionQueries(9, windows, rules)),
      contextScoped: plan(contextAcquisitionQueries(9, windows, rules, scope)),
    }).toMatchSnapshot();
  });

  it('keeps the shaping fan-out and the K2 comparison', () => {
    const row = (dims, metrics) => ({ ...dims, ...metrics });
    const shaped = {
      H2: shapeAcquisition('H2', [row({ template: 'home', bucket: 25 }, { sessions: 10 }), row({ template: 'pdp', bucket: 50 }, { sessions: 4 })]),
      H3: shapeAcquisition('H3', [row({ template: 'plp', depth: 2 }, { sessions: 7 })]),
      H5: shapeAcquisition('H5', [row({ template: 'cart_drawer', element_class: 'cart_drawer.checkout' }, { clicks: 3 })]),
      H8: shapeAcquisition('H8', [
        row({ element_class: 'pdp.add_to_cart', device: 'Mobile' }, { clicks: 5 }),
        row({ element_class: 'pdp.add_to_cart', device: 'Desktop' }, { clicks: 6 }),
      ]),
      K2: shapeAcquisition('K2', [{ started: 100, completed: 40 }]),
      K2prior: shapeAcquisition('K2prior', [{ started: 90, completed: 30 }]),
      K2yoy: shapeAcquisition('K2yoy', [{ started: 80, completed: 20 }]),
      F5: shapeAcquisition('F5', [row({ template: 'home' }, { sessions: 12 })]),
    };
    const compared = compareCheckout(
      [{ started: 100, completed: 40 }],
      [{ metrics: { started: 90, completed: 30 } }],
      [{ started: '80', completed: null }],
    );
    expect({ shaped, compared }).toMatchSnapshot();
  });
});

describe('readiness, funnel, and template query characterization', () => {
  it('keeps the R, F1–F4, H1, and scorecard query specs', () => {
    const brand = { key: 'ceremonia', name: 'Ceremonia', domain: 'ceremonia.com', idsite: 9 };
    const tracked = [11, 22, 33, 44, 55, 66];
    const scorecards = Object.keys(REQUIRED_CLASSES).map((template) =>
      elementScorecardQuery(9, template, windows, entries.filter((e) => e.template === template), rules, template === 'global' ? tracked : [11]));
    expect({
      readiness: plan(readinessQueries(brand, windows, rules)),
      readinessUnresolved: plan(readinessQueries({ ...brand, idsite: 0 }, windows)),
      coverage: plan([matrixCoverageQuery(9, windows, entries)]),
      coverageEmpty: matrixCoverageQuery(9, windows, []),
      funnel: plan([
        siteKpiQuery(9, windows),
        funnelWeeklyQuery(9, windows),
        funnelChannelQuery(9, windows),
        funnelSnapshotQuery('F4', 9, windows.snapshotStart, windows.snapshotEnd),
      ]),
      templateWeekly: plan([templateWeeklyQuery(9, windows, rules, tracked), templateWeeklyQuery(9, windows)]),
      scorecards: scorecards.map((q) => (q ? plan([q])[0] : q)),
      scorecardEmpty: elementScorecardQuery(9, 'pdp', windows, [], rules, [33]),
    }).toMatchSnapshot();
  });
});
