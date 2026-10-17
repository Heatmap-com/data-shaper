/**
 * Site-window traffic exclusion.
 *
 * Dead traffic is one page, zero clicks, zero scroll, and no transaction.
 * Duration does not make that session engaged. It is excluded at any size.
 * The same shape with a transaction is a consent refusal that purchased,
 * and it is retained.
 *
 * A viewport pattern is a bot when it is square, or wider than the site's
 * phone maximum on a phone device code, and the pattern has zero orders
 * and zero clicks. Very large patterns are excluded. Large patterns are
 * watched. The descriptor s37.traffic_exclusion sets those two bars.
 */

/** Shipped bars, used when the site has no high-confidence descriptor. */
export const DEFAULT_CONSTANTS = {
  largeSessions: 5000,
  veryLargeSessions: 20000,
  largeShare: 0.01,
  veryLargeShare: 0.05,
  phoneMaxWidth: 500,
  mismatchDeviceCodes: [1],
};

const NUMBER_FIELDS = [
  ['large_sessions', 'largeSessions'],
  ['very_large_sessions', 'veryLargeSessions'],
  ['large_share', 'largeShare'],
  ['very_large_share', 'veryLargeShare'],
  ['phone_max_width', 'phoneMaxWidth'],
];

/**
 * @param {object | null | undefined} value parsed s37.traffic_exclusion value
 * @returns {{ constants: import('../../ports/traffic-exclusion.js').TrafficExclusionConstants, source: 'default' | 'descriptor' }}
 */
export function resolveConstants(value) {
  const constants = {
    ...DEFAULT_CONSTANTS,
    mismatchDeviceCodes: [...DEFAULT_CONSTANTS.mismatchDeviceCodes],
  };
  if (!value || typeof value !== 'object') return { constants, source: 'default' };
  let used = false;
  for (const [from, to] of NUMBER_FIELDS) {
    const next = Number(value[from]);
    if (!Number.isFinite(next) || next < 0) continue;
    constants[to] = next;
    used = true;
  }
  if (Array.isArray(value.mismatch_device_codes)) {
    const codes = value.mismatch_device_codes.map(Number).filter((n) => Number.isInteger(n));
    if (codes.length > 0) {
      constants.mismatchDeviceCodes = codes;
      used = true;
    }
  }
  return { constants, source: used ? 'descriptor' : 'default' };
}

/**
 * @param {number} sessions
 * @param {number} siteSessions
 */
function shareOf(sessions, siteSessions) {
  if (siteSessions <= 0) return 0;
  return sessions / siteSessions;
}

/**
 * @param {number} sessions
 * @param {number} siteSessions
 * @param {import('../../ports/traffic-exclusion.js').TrafficExclusionConstants} constants
 * @returns {'very_large' | 'large' | 'small'}
 */
function magnitude(sessions, siteSessions, constants) {
  const share = shareOf(sessions, siteSessions);
  if (sessions >= constants.veryLargeSessions || share >= constants.veryLargeShare) return 'very_large';
  if (sessions >= constants.largeSessions || share >= constants.largeShare) return 'large';
  return 'small';
}

/**
 * @param {import('../../ports/traffic-exclusion.js').ViewportPattern} pattern
 * @param {import('../../ports/traffic-exclusion.js').TrafficExclusionConstants} constants
 */
function viewportShape(pattern, constants) {
  const square = pattern.width > 0 && pattern.width === pattern.height;
  const mismatch = constants.mismatchDeviceCodes.includes(pattern.device) && pattern.width > constants.phoneMaxWidth;
  return { square, mismatch };
}

/** @type {import('../../ports/traffic-exclusion.js').TrafficExclusionAdapter} */
export const adapter = {
  id: 'viewport-dead',

  build(input) {
    const { constants } = input;
    const siteSessions = Number(input.siteSessions) || 0;
    const dead = input.dead ?? { sessions: 0, orders: 0, clicks: 0, revenue: 0 };
    const retained = input.retained ?? { sessions: 0, orders: 0, clicks: 0, revenue: 0 };
    /** @type {import('../../ports/traffic-exclusion.js').ExclusionRule[]} */
    const rules = [
      {
        ruleId: 'dead_session',
        patternKey: 'scroll:0|clicks:0|pages:1|orders:0',
        disposition: 'exclude',
        reason: 'one page, zero clicks, zero scroll, no transaction',
        sessions: Number(dead.sessions) || 0,
        orders: 0,
        clicks: 0,
        revenue: 0,
        share: shareOf(Number(dead.sessions) || 0, siteSessions),
        detail: { scroll: 0, clicks: 0, pageviews: 1, orders: 0, siteSessions },
      },
      {
        ruleId: 'consent_purchase',
        patternKey: 'scroll:0|clicks:0|pages:1|orders>0',
        disposition: 'retain',
        reason: 'one page, zero clicks, zero scroll, with a transaction',
        sessions: Number(retained.sessions) || 0,
        orders: Number(retained.orders) || 0,
        clicks: 0,
        revenue: Number(retained.revenue) || 0,
        share: shareOf(Number(retained.sessions) || 0, siteSessions),
        detail: { scroll: 0, clicks: 0, pageviews: 1, orders: Number(retained.orders) || 0, siteSessions },
      },
    ];

    const patterns = [...(input.patterns ?? [])].sort((a, b) => b.sessions - a.sessions || a.resolution.localeCompare(b.resolution));
    for (const pattern of patterns) {
      const shape = viewportShape(pattern, constants);
      if (!shape.square && !shape.mismatch) continue;
      if ((Number(pattern.orders) || 0) > 0 || (Number(pattern.clicks) || 0) > 0) continue;
      const size = magnitude(pattern.sessions, siteSessions, constants);
      if (size === 'small') continue;
      const kind = shape.square ? 'square viewport' : `device ${pattern.device} viewport width ${pattern.width} over ${constants.phoneMaxWidth}`;
      rules.push({
        ruleId: 'viewport_pattern',
        patternKey: `${pattern.resolution}|d${pattern.device}`,
        disposition: size === 'very_large' ? 'exclude' : 'watch',
        reason: `${size === 'very_large' ? 'very large' : 'large'} ${kind}, zero orders, zero clicks`,
        sessions: pattern.sessions,
        orders: 0,
        clicks: 0,
        revenue: Number(pattern.revenue) || 0,
        share: shareOf(pattern.sessions, siteSessions),
        detail: {
          resolution: pattern.resolution,
          device: pattern.device,
          width: pattern.width,
          height: pattern.height,
          square: shape.square,
          mismatch: shape.mismatch,
          magnitude: size,
          siteSessions,
        },
      });
    }
    return { rules, constants };
  },
};
