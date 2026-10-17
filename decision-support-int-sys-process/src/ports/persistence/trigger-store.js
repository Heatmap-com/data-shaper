/**
 * Trigger definitions, hits, and chains.
 *
 * @typedef {Object} TriggerStore
 * @property {(batch: {definitions?: object[], hits?: object[], chains?: object[]}) => Promise<void>} writeTriggerBatch idempotent on definition version and on hit/chain identity
 * @property {(idsite: number) => Promise<object[]>} readTriggerDefinitions latest per key; a site row wins over idsite 0
 * @property {(key: {idsite: number, triggerKey?: string, start?: string, end?: string}) => Promise<object[]>} readTriggerHits
 * @property {(key: {idsite: number, triggerKey?: string, start?: string, end?: string}) => Promise<object[]>} readTriggerChains
 */

export const TRIGGER_STORE = Object.freeze([
  'writeTriggerBatch',
  'readTriggerDefinitions',
  'readTriggerHits',
  'readTriggerChains',
]);
