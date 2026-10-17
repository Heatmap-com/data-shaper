/** @typedef {import('../persistence.js').AeChangeRow} AeChangeRow */
/** @typedef {import('../persistence.js').AeDescriptorRow} AeDescriptorRow */

/**
 * Page and store descriptors and the change log.
 *
 * @typedef {Object} DescriptorStore
 * @property {(key: {idsite: number, template_key: string, device_class?: string}) => Promise<object[]>} readPageDescriptor current rows, latest per field_path
 * @property {(key: {idsite: number}) => Promise<object[]>} readStoreDescriptor current rows, latest per field_path
 * @property {(rows: AeDescriptorRow[]) => Promise<void>} writeDescriptorRows template_key present → page, absent → store
 * @property {(idsite: number, fromIso: string, toIso: string) => Promise<object[]>} readChanges effective_at within [fromIso, toIso]
 * @property {(rows: AeChangeRow[]) => Promise<void>} writeChanges
 */

export const DESCRIPTOR_STORE = Object.freeze([
  'readPageDescriptor',
  'readStoreDescriptor',
  'writeDescriptorRows',
  'readChanges',
  'writeChanges',
]);
