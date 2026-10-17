import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SCAN_EXTS = new Set(['.js', '.mjs', '.cjs', '.sh', '.py', '']);

function walk(dirs) {
  const out = [];
  const visit = (dir) => {
    for (const e of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) visit(rel);
      else if (SCAN_EXTS.has(path.extname(e.name))) out.push(rel);
    }
  };
  for (const d of dirs) visit(d);
  return out.sort();
}

export const CLIENT_DOMAINS = [
  'loopearplugs.com',
  'kurk.life',
  'mellowsleep.com',
  'ceremonia.com',
  'tennispremium.co',
  'vitasei.com.co',
  'jormands.com.co',
  'sayiioficial.com',
  'dvf.com',
];

const SITE_LITERAL_RULES = [
  { rule: 'users-path', test: (line) => line.includes('/Users/') },
  { rule: 'tmp-path', test: (line) => line.includes('/tmp/') },
  { rule: 'client-domain', test: (line) => CLIENT_DOMAINS.some((d) => line.includes(d)) },
  { rule: 'idsite-literal', test: (line) => /\bidsite\b\s*[:=]?\s*['"]?\d+/i.test(line) },
];

export function siteLiteralHits() {
  const hits = [];
  for (const file of walk(['src', 'py', 'bin', 'scripts'])) {
    const lines = fs.readFileSync(path.join(repoRoot, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const { rule, test } of SITE_LITERAL_RULES) {
        if (test(line)) hits.push({ file, line: i + 1, rule, snippet: line.trim() });
      }
    });
  }
  return hits;
}

const READS_ENV = (line) => /\bprocess\.env\b/.test(line);
const IMPORTS_PERSISTENCE = (line) => /from\s+['"][^'"]*adapters\/persistence\//.test(line);
const IMPORTS_CLICKHOUSE = (line) => /from\s+['"]@clickhouse\/client['"]/.test(line);

const compositionRoot = (file) => file.startsWith('src/composition/') || file.startsWith('src/orchestrator/composition/');

export function compositionHits() {
  const hits = [];
  const push = (file, lines, rule, test) => {
    lines.forEach((line, i) => {
      if (test(line)) hits.push({ file, line: i + 1, rule, snippet: line.trim() });
    });
  };
  for (const file of walk(['src'])) {
    const lines = fs.readFileSync(path.join(repoRoot, file), 'utf8').split('\n');
    if (!compositionRoot(file)) push(file, lines, 'reads-process-env', READS_ENV);
    if (!compositionRoot(file) && !file.startsWith('src/adapters/')) push(file, lines, 'imports-persistence-adapter', IMPORTS_PERSISTENCE);
  }
  for (const file of walk(['src', 'py', 'scripts'])) {
    if (compositionRoot(file) || file.startsWith('src/adapters/persistence/')) continue;
    const lines = fs.readFileSync(path.join(repoRoot, file), 'utf8').split('\n');
    push(file, lines, 'imports-clickhouse-client', IMPORTS_CLICKHOUSE);
  }
  return hits;
}

export function hitKey(h) {
  return `${h.file} | ${h.rule} | ${h.snippet}`;
}

export function counts(hits) {
  const tally = new Map();
  for (const hit of hits) tally.set(hitKey(hit), (tally.get(hitKey(hit)) ?? 0) + 1);
  return tally;
}
