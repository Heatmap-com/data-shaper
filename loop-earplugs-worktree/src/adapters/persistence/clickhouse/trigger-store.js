import { clock, hitFromCh, chainFromCh } from './support.js';

/**
 * The TriggerStore role over ClickHouse: trigger definitions, hits, and chains.
 * @param {object} support the adapter's shared state from support.js
 * @returns {import('../../../ports/persistence/trigger-store.js').TriggerStore}
 */
export function createTriggerStore({ client, database, log, timedWrite, run, insertTriggerChunks }) {
  return {
    /**
     * Replaces definitions, hits, and chains on their ORDER BY identity.
     * A later generated_at wins, so a rerun of the same day replaces the
     * open chain rows.
     * @param {{definitions?: object[], hits?: object[], chains?: object[]}} batch
     */
    async writeTriggerBatch(batch) {
      const definitions = batch.definitions ?? [];
      const hits = batch.hits ?? [];
      const chains = batch.chains ?? [];
      if (definitions.length > 0) {
        await timedWrite('ae_trigger_definition', definitions, () => client.insert({
          table: `${database}.ae_trigger_definition`,
          format: 'JSONEachRow',
          values: definitions.map((row) => ({
            idsite: row.idsite,
            trigger_key: row.key,
            name: row.name,
            level: row.level,
            version: row.version,
            predicate: JSON.stringify(row.predicate ?? {}),
            active: row.active === false ? 0 : 1,
            generated_at: clock.now(),
          })),
        }));
      }
      await insertTriggerChunks('ae_trigger_hit', hits, (row) => ({
        idsite: row.idsite,
        trigger_key: row.triggerKey,
        server_date: row.serverDate,
        trigger_version: row.triggerVersion,
        idvisit: row.idvisit,
        config_id: row.configId ?? '',
        level: row.level,
        device: row.device ?? '',
        channel: row.channel ?? '',
        source: row.source ?? '',
        medium: row.medium ?? '',
        returning: row.returning ?? '',
        country: row.country ?? '',
        landing_page: row.landingPage ?? '',
        entry_template: row.entryTemplate ?? '',
        generated_at: clock.now(),
      }));
      await insertTriggerChunks('ae_trigger_chain', chains, (row) => ({
        idsite: row.idsite,
        trigger_key: row.triggerKey,
        server_date: row.serverDate,
        trigger_version: row.triggerVersion,
        idvisit: row.idvisit,
        config_id: row.configId ?? '',
        level: row.level ?? '',
        device: row.device ?? '',
        channel: row.channel ?? '',
        source: row.source ?? '',
        medium: row.medium ?? '',
        returning: row.returning ?? '',
        country: row.country ?? '',
        landing_page: row.landingPage ?? '',
        entry_template: row.entryTemplate ?? '',
        returned: row.returned ? 1 : 0,
        sessions_until_return: row.sessionsUntilReturn ?? 0,
        sessions_until_purchase: row.sessionsUntilPurchase ?? 0,
        purchased: row.purchased ? 1 : 0,
        revenue: row.revenue ?? 0,
        seconds_to_purchase: row.secondsToPurchase ?? 0,
        recovered: row.recovered ? 1 : 0,
        window_days: row.windowDays,
        window_closes: row.windowCloses,
        final: row.final ? 1 : 0,
        generated_at: clock.now(),
      }));
      log('writeTriggerBatch', { definitions: definitions.length, hits: hits.length, chains: chains.length });
    },

    /** Latest definition per key. A site row wins over the idsite 0 default. */
    async readTriggerDefinitions(idsite) {
      const rows = await run(client.query({
        query: `
          SELECT *
            FROM ${database}.ae_trigger_definition_current
           WHERE idsite = {idsite:UInt32} OR idsite = 0`,
        query_params: { idsite },
        format: 'JSONEachRow',
      }));
      /** @type {Map<string, object>} */
      const latest = new Map();
      for (const row of rows) {
        const key = row.trigger_key;
        const prev = latest.get(key);
        const specific = Number(row.idsite) === Number(idsite);
        const prevSpecific = prev && Number(prev.idsite) === Number(idsite);
        const newer = !prev || Number(row.version) >= Number(prev.version);
        if (!prev || (specific && !prevSpecific) || (specific === prevSpecific && newer)) {
          latest.set(key, row);
        }
      }
      return [...latest.values()].map((row) => ({
        idsite: Number(row.idsite),
        key: row.trigger_key,
        name: row.name,
        level: row.level,
        version: Number(row.version),
        predicate: typeof row.predicate === 'string' ? JSON.parse(row.predicate) : row.predicate,
        active: Number(row.active) === 1,
      }));
    },

    /** @param {{idsite: number, triggerKey?: string, start?: string, end?: string}} key */
    async readTriggerHits(key) {
      const rows = await run(client.query({
        query: `
          SELECT *
            FROM ${database}.ae_trigger_hit_current
           WHERE idsite = {idsite:UInt32}
             AND ({triggerKey:String} = '' OR trigger_key = {triggerKey:String})
             AND server_date BETWEEN {start:Date} AND {end:Date}`,
        query_params: {
          idsite: key.idsite,
          triggerKey: key.triggerKey ?? '',
          start: key.start ?? '1970-01-01',
          end: key.end ?? '2149-06-06',
        },
        format: 'JSONEachRow',
      }));
      return rows.map(hitFromCh);
    },

    /** @param {{idsite: number, triggerKey?: string, start?: string, end?: string}} key */
    async readTriggerChains(key) {
      const rows = await run(client.query({
        query: `
          SELECT *
            FROM ${database}.ae_trigger_chain_current
           WHERE idsite = {idsite:UInt32}
             AND ({triggerKey:String} = '' OR trigger_key = {triggerKey:String})
             AND server_date BETWEEN {start:Date} AND {end:Date}`,
        query_params: {
          idsite: key.idsite,
          triggerKey: key.triggerKey ?? '',
          start: key.start ?? '1970-01-01',
          end: key.end ?? '2149-06-06',
        },
        format: 'JSONEachRow',
      }));
      return rows.map(chainFromCh);
    },
  };
}
