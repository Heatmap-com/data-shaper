/**
 * Name the click selectors the strategy rules actually read.
 *
 * The harvest writes a different CSS dialect than udp click idselectors, so
 * exact match never joins. This resolves each heavy click selector in the
 * live page, classifies that element, and stores the class under the click
 * selector. Rules then see element_class on the row they already filter.
 *
 * Usage:
 *   node bin/name-click-selectors.mjs --batch <batch_id> --sites <idsite>[,<idsite>...] [--url <page url>]
 *
 * The page is the batch's analysis page for each site; `--url` stands in
 * when that row has no URL and is accepted with one site only. Playwright
 * is loaded from the naming bot (`naming.botDir`, or CNN_AI_BOT_DIR).
 * Reads ClickHouse credentials from the environment (sourced ~/.zshrc).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { idsites, parseFlags, valueOf } from '../src/application/commands/args.js';
import { clickHouseConfig, createClickHouseClient } from '../src/composition/clickhouse.js';
import { loadConfig } from '../src/config.js';
import { assignClickClasses } from '../src/naming-mapper.js';

const TOP_SELECTORS = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The batch and the sites to name, from the command line.
 * @param {string[]} argv
 * @returns {{batchId: string, sites: Array<{idsite: number, url: string}>}}
 */
export function namingRequest(argv) {
  const flags = parseFlags(argv);
  const batchId = valueOf(flags, 'batch');
  if (!batchId || !UUID.test(batchId)) throw new Error('--batch <batch_id> is required and must be a UUID');
  const list = idsites(valueOf(flags, 'sites'));
  if (list.length === 0) throw new Error('--sites <idsite>[,<idsite>...] is required');
  const url = valueOf(flags, 'url') ?? '';
  if (url && list.length !== 1) throw new Error('--url names one page; pass it with one idsite in --sites');
  return { batchId, sites: list.map((idsite) => ({ idsite, url })) };
}

/**
 * Playwright as the naming bot installs it.
 * @param {string} botDir
 */
export function playwrightFrom(botDir) {
  if (!botDir) throw new Error('naming.botDir is not set; set CNN_AI_BOT_DIR or naming.botDir in analysis.config.json');
  return createRequire(path.join(botDir, 'package.json'))('playwright');
}

function loadEnv() {
  const wanted = ['CLICKHOUSE_HOST', 'CLICKHOUSE_PORT', 'CLICKHOUSE_USER', 'CLICKHOUSE_PASSWORD'];
  const env = { ...process.env };
  if (env.CLICKHOUSE_HOST && env.CLICKHOUSE_PASSWORD) return env;
  for (const line of readFileSync(`${process.env.HOME}/.zshrc`, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('export ') || !t.includes('=')) continue;
    const body = t.slice(7);
    const i = body.indexOf('=');
    const k = body.slice(0, i).trim();
    if (!wanted.includes(k)) continue;
    let v = body.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[k] = v;
  }
  return env;
}

async function clickSelectors(client, database, batchId, idsite) {
  const result = await client.query({
    query: `
      SELECT dim_selector AS selector, sum(JSONExtractFloat(metrics, 'clicks')) AS clicks
      FROM ${database}.landing_page_dataset_current
      WHERE toString(batch_id) = {batch:String}
        AND idsite = {idsite:UInt32}
        AND dataset_id = 'selector-weekly'
        AND bot_filter = 'exclude_confirmed'
        AND dim_selector != ''
      GROUP BY selector
      ORDER BY clicks DESC
      LIMIT {lim:UInt32}
    `,
    query_params: { batch: batchId, idsite, lim: TOP_SELECTORS },
    format: 'JSONEachRow',
  });
  return result.json();
}

async function pageHsr(client, database, batchId, idsite) {
  const result = await client.query({
    query: `
      SELECT idsitehsr, landing_page_url
      FROM ${database}.landing_page_analysis_current
      WHERE toString(batch_id) = {batch:String} AND idsite = {idsite:UInt32}
      LIMIT 1
    `,
    query_params: { batch: batchId, idsite },
    format: 'JSONEachRow',
  });
  const rows = await result.json();
  return rows[0] ?? null;
}

async function inspect(page, selectors) {
  return page.evaluate((list) => {
    return list.map((selector) => {
      let el = null;
      try {
        el = document.querySelector(selector);
      } catch {
        return { selector, resolved: false };
      }
      if (!el) return { selector, resolved: false };
      const chain = [];
      let node = el;
      for (let i = 0; i < 8 && node && node !== document.documentElement; i += 1) {
        const id = node.id ? `#${node.id}` : '';
        const cls = typeof node.className === 'string'
          ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).map((c) => `.${c}`).join('')
          : '';
        chain.push(`${(node.tagName || '').toLowerCase()}${id}${cls}`);
        node = node.parentElement;
      }
      const link = typeof el.closest === 'function' ? el.closest('a') : null;
      const control = (typeof el.closest === 'function' && el.closest('a, button, summary')) || el;
      const rect = el.getBoundingClientRect();
      const own = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '')
        .replace(/\s+/g, ' ')
        .trim();
      const fromControl = (control.innerText || control.getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ')
        .trim();
      const raw = (own || fromControl).slice(0, 180);
      return {
        selector,
        resolved: true,
        tag: (control.tagName || el.tagName || '').toLowerCase(),
        role: control.getAttribute('role') || el.getAttribute('role') || '',
        ariaLabel: control.getAttribute('aria-label') || el.getAttribute('aria-label') || '',
        href: (link && link.getAttribute('href')) || control.getAttribute('href') || '',
        text: raw.slice(0, 180),
        boxTop: rect.top + window.scrollY,
        viewportHeight: window.innerHeight || 900,
        ancestors: chain.join(' > '),
      };
    });
  }, selectors);
}

async function main() {
  const { batchId, sites } = namingRequest(process.argv.slice(2));
  const { chromium } = playwrightFrom(loadConfig().naming.botDir);
  const config = clickHouseConfig(loadEnv());
  const { database } = config;
  const client = createClickHouseClient(config);
  const browser = await chromium.launch({ headless: true });
  const namedOn = new Date().toISOString().slice(0, 10);
  const generatedAt = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const summary = [];

  try {
    for (const site of sites) {
      const started = Date.now();
      const pageRow = await pageHsr(client, database, batchId, site.idsite);
      const selectors = await clickSelectors(client, database, batchId, site.idsite);
      if (!pageRow || selectors.length === 0) {
        summary.push({ idsite: site.idsite, error: 'no analysis page or click selectors' });
        continue;
      }
      const url = pageRow.landing_page_url || site.url;
      if (!url) {
        summary.push({ idsite: site.idsite, error: 'the analysis page has no URL; pass --url' });
        continue;
      }
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      let observations = [];
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2000);
        observations = await inspect(page, selectors.map((row) => row.selector));
      } catch (err) {
        summary.push({ idsite: site.idsite, url, error: err instanceof Error ? err.message : String(err) });
        await context.close();
        continue;
      }
      const names = assignClickClasses(observations.filter((row) => row.resolved));
      if (names.length > 0) {
        await client.insert({
          table: `${database}.page_element_name`,
          format: 'JSONEachRow',
          values: names.map((name) => ({
            idsite: site.idsite,
            idsitehsr: Number(pageRow.idsitehsr),
            selector: name.selector,
            element_class: name.element_class,
            name: name.name,
            named_on: namedOn,
            generated_at: generatedAt,
          })),
        });
      }
      const byClass = {};
      for (const name of names) byClass[name.element_class] = (byClass[name.element_class] ?? 0) + 1;
      summary.push({
        idsite: site.idsite,
        url,
        click_selectors: selectors.length,
        resolved: observations.filter((row) => row.resolved).length,
        classed: names.length,
        classes: byClass,
        seconds: Math.round((Date.now() - started) / 100) / 10,
      });
      console.log(JSON.stringify(summary[summary.length - 1]));
      await context.close();
    }
  } finally {
    await browser.close();
    await client.close();
  }
  console.log(JSON.stringify({ sites: summary.length, summary }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
