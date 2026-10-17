import { randomUUID } from 'node:crypto';
import { resolveConstants } from '../adapters/traffic-exclusion/viewport-dead.js';
import { measureTraffic } from './measure.js';

/**
 * Reads s37.traffic_exclusion when it is high confidence, measures the
 * window, and appends one model version.
 * @param {object} opts
 * @param {number} opts.idsite
 * @param {string} opts.windowStart
 * @param {string} opts.windowEnd
 * @param {import('../ports/traffic-exclusion.js').TrafficExclusionAdapter} opts.adapter
 * @param {import('../ports/dataset.js').QueryGateway} opts.gateway
 * @param {import('../ports/persistence/descriptor-store.js').DescriptorStore & import('../ports/persistence/dataset-store.js').DatasetStore} opts.persistence
 * @param {{info?: Function}} [opts.logger]
 */
export async function runTrafficExclusion(opts) {
  const stored = await opts.persistence.readStoreDescriptor({ idsite: opts.idsite });
  const descriptor = (stored ?? []).find((row) => row.field_path === 's37.traffic_exclusion' && row.confidence === 'high');
  let parsed = null;
  if (descriptor?.value_json) {
    try {
      parsed = JSON.parse(descriptor.value_json);
    } catch {
      parsed = null;
    }
  }
  const { constants, source } = resolveConstants(parsed);
  const measured = await measureTraffic(opts.gateway, {
    idsite: opts.idsite,
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd,
  });
  const built = opts.adapter.build({ ...measured, constants });
  const modelId = randomUUID();
  const constantsJson = JSON.stringify({ ...constants, source });
  const rows = built.rules.map((rule) => ({
    modelId,
    idsite: opts.idsite,
    adapterId: opts.adapter.id,
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd,
    ruleId: rule.ruleId,
    patternKey: rule.patternKey,
    disposition: rule.disposition,
    reason: rule.reason,
    sessions: rule.sessions,
    orders: rule.orders,
    clicks: rule.clicks,
    revenue: rule.revenue,
    share: rule.share,
    constantsJson,
    detailJson: JSON.stringify({ ...rule.detail, constantsSource: source }),
  }));
  await opts.persistence.writeTrafficExclusionModel(rows);
  const summary = {
    modelId,
    idsite: opts.idsite,
    adapterId: opts.adapter.id,
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd,
    constantsSource: source,
    siteSessions: measured.siteSessions,
    rules: built.rules.length,
    deadSessions: built.rules.find((rule) => rule.ruleId === 'dead_session')?.sessions ?? 0,
    patternExclusions: built.rules.filter((rule) => rule.ruleId === 'viewport_pattern' && rule.disposition === 'exclude').length,
    watched: built.rules.filter((rule) => rule.disposition === 'watch').length,
  };
  opts.logger?.info?.(summary, 'traffic exclusion model');
  return { ...summary, rules: built.rules, constants };
}
