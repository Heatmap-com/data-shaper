import { createAeStore, createStore } from './memory/support.js';
import { createLandingPageStore } from './memory/landing-page-store.js';
import { createNamingQueue } from './memory/naming-queue.js';
import { createBatchStore } from './memory/batch-store.js';
import { createCaptureStore } from './memory/capture-store.js';
import { createDatasetStore } from './memory/dataset-store.js';
import { createTrendStore } from './memory/trend-store.js';
import { createSessionTagStore } from './memory/session-tag-store.js';
import { createDescriptorStore } from './memory/descriptor-store.js';
import { createGovernanceStore } from './memory/governance-store.js';
import { createTriggerStore } from './memory/trigger-store.js';
import { createSegmentationStore } from './memory/segmentation-store.js';
import { createCardAnalysisStore } from './memory/card-analysis-store.js';
import { createCatalogSeedStore } from './memory/catalog-seed-store.js';

/**
 * In-memory persistence: the test double for the v1 and schema-2 ports,
 * composed of one module per role port (src/ports/persistence/). Contract
 * tests run the same script against this and the ClickHouse adapter.
 *
 * Rows behave like the _current views: one current row per order key, the
 * latest write wins, a rerun replaces instead of duplicating. Claims are
 * exclusive in-process with the same TTL semantics as ClickHouse.
 */

/** @returns {{adapter: import('../../ports/persistence.js').PersistencePort, snapshot: () => object}} */
export function createMemoryPersistence() {
  const store = createStore();
  const support = { store };

  return {
    adapter: {
      id: 'memory',
      ...createLandingPageStore(support),
      ...createNamingQueue(support),
    },

    snapshot() {
      return {
        batches: [...store.batches.values()].map((b) => ({ ...b })),
        queue: [...store.queue.values()].map((r) => ({ ...r })),
        analyses: [...store.analyses.values()].map((r) => ({ ...r })),
        datasets: [...store.datasets.values()].map((r) => ({ ...r })),
        namingQueue: [...store.namingQueue.values()].map((r) => ({ ...r })),
        naming: [...store.naming.values()].map((r) => ({ ...r })),
        elementNames: [...store.elementNames.entries()].map(([k, v]) => [k, v.map((n) => ({ ...n }))]),
      };
    },
  };
}

/** @returns {{adapter: import('../../ports/persistence.js').AePersistencePort, snapshot: () => object}} */
export function createMemoryAePersistence() {
  const store = createAeStore();
  const support = { store, today: () => new Date().toISOString().slice(0, 10) };

  return {
    adapter: {
      id: 'memory-ae',
      ...createBatchStore(support),
      ...createCaptureStore(support),
      ...createDatasetStore(support),
      ...createTrendStore(support),
      ...createSessionTagStore(support),
      ...createDescriptorStore(support),
      ...createGovernanceStore(support),
      ...createTriggerStore(support),
      ...createSegmentationStore(support),
      ...createCardAnalysisStore(support),
      ...createCatalogSeedStore(support),
    },

    snapshot() {
      const copy = (map) => [...map.values()].map((r) => ({ ...r }));
      return {
        batches: copy(store.batches),
        siteQueue: copy(store.siteQueue),
        pageTargets: copy(store.pageTargets),
        subjectTargets: copy(store.subjectTargets),
        captureQueue: copy(store.captureQueue),
        pageCaptures: copy(store.pageCaptures),
        elementBindings: copy(store.elementBindings),
        pageRenders: copy(store.pageRenders),
        renderNodes: copy(store.renderNodes),
        pageDescriptors: copy(store.pageDescriptors),
        storeDescriptors: copy(store.storeDescriptors),
        changeLog: copy(store.changeLog),
        experiments: copy(store.experiments),
        experimentDescriptors: copy(store.experimentDescriptors),
        experimentRows: copy(store.experimentRows),
        verdicts: copy(store.verdicts),
        toolRegistry: copy(store.toolRegistry),
        datasetRows: copy(store.datasetRows),
        analysisCheckpoints: copy(store.analysisCheckpoints),
        requirementStatus: copy(store.requirementStatus),
        strategyCards: copy(store.strategyCards),
        pageAnalyses: copy(store.pageAnalyses),
        siteAnalyses: copy(store.siteAnalyses),
        triggerDefinitions: copy(store.triggerDefinitions),
        segmentationDefinitions: copy(store.segmentationDefinitions),
        triggerHits: copy(store.triggerHits),
        triggerChains: copy(store.triggerChains),
        requirements: copy(store.requirements),
        strategyCatalog: copy(store.strategyCatalog),
        crosswalk: copy(store.crosswalk),
        screenRules: copy(store.screenRules),
        trendRows: copy(store.trendRows),
        trendSelectors: copy(store.trendSelectors),
        tagTrendRows: copy(store.tagTrendRows),
        tagSelection: copy(store.tagSelection),
      };
    },
  };
}

export const adapter = createMemoryPersistence().adapter;
export const adapters = [adapter, createMemoryAePersistence().adapter];
