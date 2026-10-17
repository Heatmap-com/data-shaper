/**
 * Gets the names harvested for one claimed page: runs the naming bot when
 * one is configured, then reads its names.json. Shared by the capture
 * consumer and the v1 naming consumer.
 *
 * @typedef {Object} HarvestPort
 * @property {(job: {idsite: number, idsitehsr: number, url: string}, naming: {command?: string, botDir?: string, datasetRoot?: string, botTimeoutMs?: number}, logger: object) => Promise<Array<object>>} harvestNames NameRows
 */
