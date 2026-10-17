import { describe, expect, it } from 'vitest';
import { twoProportionZ } from '../../src/audit/stats.js';
import { twoProportion } from '../../src/experiments/stats.js';
import { liftIntervalExcludesOne, wilsonInterval } from '../../src/product-grid/stats.js';

/**
 * The audit, experiment, and product-grid proportion statistics share one
 * module. The snapshot was taken from the three separate copies, edge cases
 * included, so each caller keeps its own answer for empty, degenerate, and
 * out-of-range inputs. One answer changed on purpose: an experiment arm with
 * a missing or NaN sample size has a null lift, as the audit copy already
 * gave, where the old copy returned NaN.
 */

const CASES = [
  [30, 1000, 20, 1000],
  [120, 4000, 90, 4100],
  [5, 50, 5, 50],
  [0, 100, 0, 100],
  [100, 100, 100, 100],
  [0, 0, 3, 10],
  [3, 10, 0, 0],
  [-1, 10, 2, 10],
  [12, 10, 2, 10],
  [3, Number.NaN, 2, 10],
  [3, undefined, 2, 10],
  [7, 1e9, 9, 1e9],
];

describe('proportion statistics', () => {
  it('two-proportion tests keep their answers', () => {
    const rows = CASES.map(([x1, n1, x2, n2]) => ({
      input: [x1, n1, x2, n2].map(String),
      audit: twoProportionZ(x1, n1, x2, n2),
      experiment: twoProportion(x1, n1, x2, n2),
    }));
    expect(rows).toMatchSnapshot();
  });

  it('Wilson intervals keep their answers', () => {
    const rows = [[0, 0], [0, 10], [3, 10], [10, 10], [45, 900], [1, 3], [5, Number.NaN]].map(([k, n]) => ({
      input: [k, n].map(String),
      interval: wilsonInterval(k, n),
      excludesOne: [0.001, 0.05, 0.5].map((ctr) => liftIntervalExcludesOne(k, n, ctr)),
    }));
    expect(rows).toMatchSnapshot();
  });
});
