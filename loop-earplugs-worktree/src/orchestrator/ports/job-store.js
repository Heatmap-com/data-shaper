/**
 * The job is the record of one site going through one resolved run. Queue
 * messages carry only the job id and the stage; everything else is here.
 *
 * @typedef {'pending'|'queued'|'running'|'done'|'blocked'|'failed'|'skipped'} StageStatus
 * @typedef {'queued'|'running'|'done'|'blocked'|'failed'|'cancelled'} JobStatus
 *
 * @typedef {Object} StageState
 * @property {StageStatus} status
 * @property {number} attempts deliveries that ran the primary handler
 * @property {number} fallbackAttempts
 * @property {string|null} startedAt
 * @property {string|null} finishedAt
 * @property {string|null} recoveredBy agent descriptor id when the fallback completed the stage
 * @property {string|null} note
 * @property {string|null} lastError
 *
 * @typedef {Object} Job
 * @property {string} id
 * @property {number} version
 * @property {JobStatus} status
 * @property {'critical'|'high'|'normal'|'low'} priority
 * @property {'standard'|'top'} resilience
 * @property {import('./descriptor-source.js').SiteSpec} site
 * @property {Array<{url: string, role?: string}>} pages
 * @property {{start: string, end: string}} window
 * @property {import('../domain/run-descriptor.js').ResolvedRun} run
 * @property {{refs: Array<{ref: string, file: string}>, hash: string}} provenance
 * @property {Object<string, StageState>} stages keyed by stage id
 * @property {string|null} blocker
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {Object} JobStorePort
 * @property {(job: Job) => Promise<Job>} create
 * @property {(id: string) => Promise<Job|null>} get
 * @property {(id: string, mutate: (job: Job) => Job|void) => Promise<Job>} update serialized per job
 * @property {(filter?: {status?: JobStatus[]}) => Promise<Job[]>} list oldest first
 * @property {(domain: string) => Promise<Job[]>} findOpenByDomain
 * @property {(id: string) => Promise<boolean>} remove false when there was no such job
 */
export {};
