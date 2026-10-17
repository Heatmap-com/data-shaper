import { readFile } from 'node:fs/promises';
import { configuredDatabase } from '../../adapters/query-gateway/clickhouse.js';
import { parseDescriptorImport } from '../../descriptor-import.js';
import { parseGovernanceImport } from '../../governance-import.js';
import { parseToolRegistryImport } from '../../tool-registry-import.js';
import { failed, ok } from './args.js';

/**
 * --descriptor-import (plan §9.6, Phase 5 write path). Every row validates
 * against src/catalog/descriptor.schema.json (paths, sub-paths, provenance
 * and confidence enums, owner); defaults fill device_class, template_key,
 * captured_at and the 90-day operator expiry. On error every violation is
 * returned and nothing is written. On success rows are written through
 * persistence.writeDescriptorRows (template_key present → ae_page_descriptor,
 * absent → ae_store_descriptor), with counts per provenance. --dry-run
 * validates only.
 */
export const descriptorImport = {
  flag: 'descriptor-import',
  usage: '--descriptor-import <file> [--dry-run]',
  async run(flags, ctx) {
    const file = flags['descriptor-import'];
    const parsed = parseDescriptorImport(await readFile(file, 'utf8'));
    if (parsed.errors.length > 0) return failed(parsed.errors);
    const byProvenance = {};
    for (const row of parsed.rows) byProvenance[row.provenance] = (byProvenance[row.provenance] ?? 0) + 1;
    if (flags['dry-run'] !== undefined) return ok({ file, rows: parsed.rows.length, by_provenance: byProvenance, dry_run: true });
    await ctx.persistence().writeDescriptorRows(parsed.rows);
    return ok({ file, rows: parsed.rows.length, by_provenance: byProvenance });
  },
};

/**
 * --governance-import (plan §9.6, Phase 5 write path). Experiments land in
 * ae_experiment, experiment descriptors in ae_experiment_descriptor
 * (provenance operator), review verdicts in ae_review_verdict (verdict_id
 * uuid when absent), manual changes in ae_change_log (deterministic
 * change_id), and promo calendar events become ae_store_descriptor rows on
 * s35.calendar. Same error contract as --descriptor-import.
 */
export const governanceImport = {
  flag: 'governance-import',
  usage: '--governance-import <file> [--dry-run]',
  async run(flags, ctx) {
    const file = flags['governance-import'];
    const parsed = parseGovernanceImport(await readFile(file, 'utf8'));
    if (parsed.errors.length > 0) return failed(parsed.errors);
    const byKind = {
      experiment: parsed.experiments.length,
      experiment_descriptor: parsed.experimentDescriptors.length,
      review_verdict: parsed.verdicts.length,
      change: parsed.changes.length,
      calendar_event: parsed.descriptorRows.length,
    };
    const rows = Object.values(byKind).reduce((sum, n) => sum + n, 0);
    if (flags['dry-run'] !== undefined) return ok({ file, rows, by_kind: byKind, dry_run: true });
    // ae_experiment_descriptor may predate the next batch's schema run.
    if (!ctx.injected.persistence) await ctx.ensure('ae');
    const store = ctx.persistence();
    await store.writeExperiments(parsed.experiments);
    if (parsed.experimentDescriptors.length > 0) await store.writeExperimentDescriptors(parsed.experimentDescriptors);
    await store.writeVerdicts(parsed.verdicts);
    await store.writeChanges(parsed.changes);
    await store.writeDescriptorRows(parsed.descriptorRows);
    return ok({ file, rows, by_kind: byKind });
  },
};

/**
 * --tool-registry-import: validate and write ae_tool_registry rows (V13,
 * plan §7.3). Shape errors and collisions throw before any write. The
 * collision baseline is what is already seeded, read through the gateway,
 * one query per idsite in the file (the fleet guard's {idsite} rule); a
 * pre-schema table is an empty baseline. --dry-run validates and reports
 * without writing.
 */
export const toolRegistryImport = {
  flag: 'tool-registry-import',
  usage: '--tool-registry-import <file> [--dry-run]',
  async run(flags, ctx) {
    const file = flags['tool-registry-import'];
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const shape = parseToolRegistryImport(raw, { existing: [] });
    await ctx.ensure('ae', 'v1');
    const gateway = ctx.gateway();

    /** @type {object[]} */
    const existing = [];
    for (const idsite of [...new Set(shape.rows.map((r) => r.idsite))]) {
      try {
        existing.push(
          ...(await gateway.query(
            `SELECT idsite, tool, vendor, parent_company, installed, modules, plan_tier, pricing_basis,
                    surfaces_owned, identity_key, revenue_join_class, event_taxonomy_status, api_status,
                    detection_sources, detection_confidence, note
               FROM ${configuredDatabase()}.ae_tool_registry_current
              WHERE idsite = {idsite:UInt32}`,
            { idsite },
            'tool-registry-import:existing',
          )),
        );
      } catch (err) {
        if (!/UNKNOWN_TABLE|Unknown table/i.test(String(err?.message ?? err))) throw err;
      }
    }

    const parsed = parseToolRegistryImport(raw, { existing });
    if (flags['dry-run'] === 'true') return ok({ file, rows: parsed.rows.length, existing: existing.length, dry_run: true });
    await ctx.persistence().writeToolRegistry(parsed.rows);
    return ok({ file, rows: parsed.rows.length, written: parsed.rows.length });
  },
};
