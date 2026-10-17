import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eachDay } from '../../src/domain/shaping/dates.js';

/**
 * Synthetic rows for the shipped source kinds, in the files the
 * synthetic-file adapter reads: `meta_ads.jsonl`, `ga4.jsonl`, and
 * `site_catalog.jsonl`, each with what a real export would hold. The rows
 * come from a seeded generator, so a seed gives the same files every time.
 * `messy` spells keys the way exports do (padded campaign names, upper-case
 * GA4 sources) so the key transforms are exercised.
 */

export const DEFAULT_CAMPAIGNS = Object.freeze(['fall_sale', 'retarget', 'brand', 'prospecting']);

export const DEFAULT_GA4_PAIRS = Object.freeze([
  ['google', 'cpc'],
  ['facebook', 'paid'],
  ['(direct)', '(none)'],
  ['google', 'organic'],
  ['instagram', 'referral'],
]);

export const DEFAULT_CATALOG = Object.freeze([
  { path: '/products/linen-shirt', product_type: 'shirts', collection: 'summer', price_band: '50-100' },
  { path: '/products/wool-coat', product_type: 'outerwear', collection: 'fall', price_band: '200+' },
  { path: '/collections/summer', product_type: '(collection)', collection: 'summer', price_band: '(mixed)' },
  { path: '/', product_type: '(home)', collection: '(none)', price_band: '(mixed)' },
]);

/** mulberry32: a small seeded generator, so the files are reproducible. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cents = (value) => Math.round(value * 100) / 100;

/**
 * @param {object} options
 * @param {string} options.from first day
 * @param {string} options.to last day
 * @param {number} [options.seed]
 * @param {readonly string[]} [options.campaigns]
 * @param {ReadonlyArray<readonly [string, string]>} [options.ga4Pairs]
 * @param {ReadonlyArray<Record<string, string>>} [options.catalog]
 * @param {readonly string[]} [options.gaps] days no facts row is written for
 * @param {boolean} [options.messy]
 * @returns {{meta_ads: object[], ga4: object[], site_catalog: object[]}}
 */
export function syntheticSources({ from, to, seed = 7, campaigns = DEFAULT_CAMPAIGNS, ga4Pairs = DEFAULT_GA4_PAIRS, catalog = DEFAULT_CATALOG, gaps = [], messy = true }) {
  const next = random(seed);
  const skip = new Set(gaps);
  const days = eachDay(from, to).filter((day) => !skip.has(day));
  const metaAds = [];
  const ga4 = [];
  for (const day of days) {
    const weekend = [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
    campaigns.forEach((name, i) => {
      const spend = cents((40 + 30 * i) * (0.7 + 0.6 * next()) * (weekend ? 1.2 : 1));
      const impressions = Math.round(spend * (90 + 40 * next()));
      const clicks = Math.round(impressions * (0.008 + 0.01 * next()));
      const purchases = Math.round(clicks * (0.01 + 0.04 * next()));
      metaAds.push({
        date: day,
        campaign_id: `23850${String(i + 1).padStart(4, '0')}`,
        campaign_name: messy && i % 2 === 1 ? ` ${name} ` : name,
        spend,
        impressions,
        clicks,
        purchases,
        purchase_value: cents(purchases * (60 + 40 * next())),
      });
    });
    ga4Pairs.forEach(([source, medium], i) => {
      const sessions = Math.round((25 - 3 * i) * (0.6 + 0.8 * next()) * (weekend ? 1.15 : 1));
      const conversions = Math.round(sessions * (0.01 + 0.03 * next()));
      ga4.push({
        date: day,
        session_source: messy && i === 0 ? 'Google' : source,
        session_medium: medium,
        sessions,
        engaged_sessions: Math.round(sessions * (0.5 + 0.3 * next())),
        conversions,
        purchase_revenue: cents(conversions * (55 + 50 * next())),
      });
    });
  }
  const siteCatalog = catalog.map((row) => ({ ...row, path: messy && row.path !== '/' ? `${row.path.toUpperCase()} ` : row.path }));
  return { meta_ads: metaAds, ga4, site_catalog: siteCatalog };
}

/**
 * Writes the sets as `<kind>.jsonl`, and a `<kind>.coverage.json` for each
 * facts kind when `coverage` names its days.
 * @param {string} dir
 * @param {Record<string, object[]>} sets
 * @param {{coverage?: Record<string, {start: string, end: string}>}} [options]
 * @returns {string[]} the files written
 */
export function writeSyntheticSources(dir, sets, { coverage = {} } = {}) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const [kind, rows] of Object.entries(sets)) {
    const file = path.join(dir, `${kind}.jsonl`);
    writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    files.push(file);
    if (coverage[kind]) {
      const span = path.join(dir, `${kind}.coverage.json`);
      writeFileSync(span, `${JSON.stringify(coverage[kind])}\n`);
      files.push(span);
    }
  }
  return files;
}
