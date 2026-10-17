import { createHash } from 'node:crypto';

/**
 * Audit evidence rows for ae_dataset_row. idsitehsr 0 marks a site-level
 * row. bot_filter portal_11_4 keeps these out of landing-page rollups that
 * read exclude_confirmed.
 *
 * @param {string} batchId
 * @param {number} idsite
 * @param {string} datasetId
 * @param {Array<{dims: object, metrics: object}>} rows
 */
export function toAuditRows(batchId, idsite, datasetId, rows) {
  return rows.map((row) => {
    const dims = row.dims ?? {};
    const extra = { ...dims };
    delete extra.week;
    delete extra.device;
    delete extra.returning;
    delete extra.channel;
    delete extra.element_class;
    delete extra.template;
    return {
      batchId,
      idsite,
      idsitehsr: 0,
      scope: 'site',
      datasetId,
      botFilter: 'portal_11_4',
      dimWeek: dims.week || null,
      dimDevice: dims.device ?? '',
      dimSource: dims.channel ?? '',
      dimReturning: dims.returning ?? '',
      dimSelector: '',
      dimElementClass: dims.element_class ?? '',
      dimSurface: dims.template ?? '',
      dimExtra: extra,
      metrics: row.metrics ?? {},
      rowKey: rowKey(datasetId, dims),
    };
  });
}

/** @param {string} datasetId @param {object} dims */
function rowKey(datasetId, dims) {
  const stable = JSON.stringify({ datasetId, ...dims }, Object.keys({ datasetId, ...dims }).sort());
  return createHash('md5').update(stable).digest('hex');
}
