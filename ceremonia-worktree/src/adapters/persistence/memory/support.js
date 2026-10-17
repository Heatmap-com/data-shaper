/**
 * State the in-memory persistence roles share: the claim TTL, the row keys,
 * the stores, and the strictly increasing schema-2 clock.
 */

// A claim younger than this is a live agent's in-flight work and is not
// reclaimable; older claims belong to crashed workers. 15 minutes covers a
// slow analysis site; the naming consumer passes its own bot timeout.
export const CLAIM_TTL_MS = 15 * 60 * 1000;

export const keyOf = {
  batch: (b) => b.batchId,
  queue: (q) => `${q.batchId}:${q.idsite}`,
  analysis: (a) => `${a.batchId}:${a.idsite}:${a.idsitehsr}`,
  dataset: (d) => `${d.batchId}:${d.idsite}:${d.idsitehsr}:${d.datasetId}:${d.rowKey}`,
};

export function createStore() {
  return {
    batches: new Map(),
    queue: new Map(),
    analyses: new Map(),
    datasets: new Map(),
    naming: new Map(),
    namingQueue: new Map(),
    elementNames: new Map(),
  };
}

// Generated timestamps must be strictly increasing inside one process or
// generated_at-desc reads (cardHistory) tie on fast writes. Nudge the clock
// forward a millisecond whenever a write lands in the same instant.
let lastAeMs = 0;
/** @param {object} row */
export function triggerIdentity(row) {
  return [row.idsite, row.triggerKey, row.serverDate, row.idvisit, row.configId].join(':');
}

/** @param {object} row @param {{idsite: number, triggerKey?: string, start?: string, end?: string}} key */
export function triggerInRange(row, key) {
  if (Number(row.idsite) !== Number(key.idsite)) return false;
  if (key.triggerKey && row.triggerKey !== key.triggerKey) return false;
  if (key.start && row.serverDate < key.start) return false;
  if (key.end && row.serverDate > key.end) return false;
  return true;
}

export function aeNow() {
  lastAeMs = Math.max(Date.now(), lastAeMs + 1);
  return new Date(lastAeMs).toISOString().replace('T', ' ').slice(0, -1);
}

export function createAeStore() {
  return {
    batches: new Map(), // batchId
    siteQueue: new Map(), // batchId:idsite
    pageTargets: new Map(), // batchId:idsite:idsitehsr
    subjectTargets: new Map(), // batchId:idsite:subjectType:subjectKey
    captureQueue: new Map(), // idsite:idsitehsr
    pageCaptures: new Map(), // idsite:idsitehsr
    elementBindings: new Map(), // idsite:idsitehsr:selector
    pageRenders: new Map(), // idsite:idsitehsr:device
    renderNodes: new Map(), // idsite:idsitehsr:device:nodeId
    pageDescriptors: new Map(), // idsite:templateKey:deviceClass:fieldPath
    storeDescriptors: new Map(), // idsite:fieldPath
    changeLog: new Map(), // idsite:changeId
    experiments: new Map(), // idsite:experimentId
    experimentDescriptors: new Map(), // idsite:experimentKey:provenance
    experimentRows: new Map(), // idsite:experimentKey:arm:basis:idsitehsr:section:selector:viewport:segment:segmentValue:day
    verdicts: new Map(), // idsite:subjectKind:subjectRef:verdictKind:verdictId
    toolRegistry: new Map(), // idsite:tool
    datasetRows: new Map(), // batchId:idsite:idsitehsr:datasetId:rowKey
    analysisCheckpoints: new Map(), // batchId:idsite:idsitehsr:datasetId
    requirementStatus: new Map(), // batchId:idsite:idsitehsr:requirementKey
    strategyCards: new Map(), // batchId:idsite:idsitehsr:catalogId:strategyId:segmentKey
    pageAnalyses: new Map(), // batchId:idsite:idsitehsr
    siteAnalyses: new Map(), // batchId:idsite
    triggerDefinitions: new Map(), // idsite:triggerKey:version
    segmentationDefinitions: new Map(), // idsite:segmentation:version
    trafficExclusionModels: new Map(), // modelId:ruleId:patternKey
    triggerHits: new Map(), // idsite:triggerKey:serverDate:idvisit:configId
    triggerChains: new Map(), // idsite:triggerKey:serverDate:idvisit:configId
    requirements: new Map(), // registryVersion:key
    strategyCatalog: new Map(), // catalogVersion:catalogId:strategyId
    crosswalk: new Map(), // catalogVersion:intentId:catalogId:strategyId
    screenRules: new Map(), // catalogVersion:catalogId:ruleId
    trendRows: new Map(), // idsite:rowType:rowKey:rowKey1:rowKey2:viewport:segment:segmentValue:week:idsitehsr
    trendSelectors: new Map(), // idsite:idsitehsr
    tagTrendRows: new Map(), // idsite:tagKey:tagValue:viewport:segment:segmentValue:week
    tagSelection: new Map(), // idsite:tagKey
  };
}

export const IN_FLIGHT_SITE = new Set(['claimed', 'selecting_pages', 'analyzing']);
