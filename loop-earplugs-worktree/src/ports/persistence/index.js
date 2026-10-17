import { BATCH_STORE } from './batch-store.js';
import { CAPTURE_STORE } from './capture-store.js';
import { CARD_ANALYSIS_STORE } from './card-analysis-store.js';
import { CATALOG_SEED_STORE } from './catalog-seed-store.js';
import { DATASET_STORE } from './dataset-store.js';
import { DESCRIPTOR_STORE } from './descriptor-store.js';
import { GOVERNANCE_STORE } from './governance-store.js';
import { LANDING_PAGE_STORE } from './landing-page-store.js';
import { NAMING_QUEUE } from './naming-queue.js';
import { SEGMENTATION_STORE } from './segmentation-store.js';
import { SESSION_TAG_STORE } from './session-tag-store.js';
import { TREND_STORE } from './trend-store.js';
import { TRIGGER_STORE } from './trigger-store.js';

/** The role ports that make up the schema-2 persistence port, by name. */
export const AE_PERSISTENCE_ROLES = Object.freeze({
  BatchStore: BATCH_STORE,
  CaptureStore: CAPTURE_STORE,
  DatasetStore: DATASET_STORE,
  TrendStore: TREND_STORE,
  SessionTagStore: SESSION_TAG_STORE,
  DescriptorStore: DESCRIPTOR_STORE,
  GovernanceStore: GOVERNANCE_STORE,
  TriggerStore: TRIGGER_STORE,
  SegmentationStore: SEGMENTATION_STORE,
  CardAnalysisStore: CARD_ANALYSIS_STORE,
  CatalogSeedStore: CATALOG_SEED_STORE,
});

/** The role ports that make up the v1 persistence port, by name. */
export const V1_PERSISTENCE_ROLES = Object.freeze({
  LandingPageStore: LANDING_PAGE_STORE,
  NamingQueue: NAMING_QUEUE,
});

/**
 * The role methods an adapter lacks, by role. Empty when it implements them all.
 * @param {object} adapter
 * @param {Readonly<Record<string, readonly string[]>>} roles
 * @returns {Record<string, string[]>}
 */
export function missingRoleMethods(adapter, roles) {
  const missing = {};
  for (const [role, methods] of Object.entries(roles)) {
    const absent = methods.filter((name) => typeof adapter[name] !== 'function');
    if (absent.length > 0) missing[role] = absent;
  }
  return missing;
}
