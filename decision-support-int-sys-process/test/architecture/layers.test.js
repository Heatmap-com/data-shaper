// Architecture rule: dependencies point inward. Domain code imports only its
// own domain and no Node built-ins. Orchestrator application code imports the
// domain, the ports, and pure Node modules; the filesystem, processes, and
// the host come through ports. Ports hold types only. Adapters never reach
// back into application or composition code.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './_scan.js';

const IMPORT = /(?:^|\s)(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const PURE_NODE = new Set(['node:path', 'node:crypto']);

function filesUnder(dir) {
  const out = [];
  const visit = (rel) => {
    for (const entry of fs.readdirSync(path.join(repoRoot, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (child.endsWith('.js')) out.push(child);
    }
  };
  visit(dir);
  return out;
}

function importsOf(file) {
  const text = fs.readFileSync(path.join(repoRoot, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...text.matchAll(IMPORT)].map((m) => {
    const spec = m[1] ?? m[2];
    return spec.startsWith('.') ? { spec, target: path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)) } : { spec, target: spec };
  });
}

const within = (target, dir) => target === dir || target.startsWith(`${dir}/`);

const LAYERS = [
  { dir: 'src/domain', allows: (t) => within(t, 'src/domain') },
  { dir: 'src/orchestrator/domain', allows: (t) => within(t, 'src/orchestrator/domain') || within(t, 'src/domain') },
  {
    dir: 'src/orchestrator/application',
    allows: (t) => PURE_NODE.has(t) || ['application', 'domain', 'ports'].some((d) => within(t, `src/orchestrator/${d}`)) || within(t, 'src/domain'),
  },
  { dir: 'src/orchestrator/ports', allows: (t) => within(t, 'src/orchestrator/ports') || within(t, 'src/orchestrator/domain') },
  { dir: 'src/orchestrator/adapters', allows: (t) => !within(t, 'src/orchestrator/application') && !within(t, 'src/orchestrator/composition') },
];

describe('layer dependencies point inward', () => {
  for (const layer of LAYERS) {
    it(`${layer.dir} imports only what its layer allows`, () => {
      const bad = filesUnder(layer.dir).flatMap((file) => importsOf(file)
        .filter(({ target }) => !layer.allows(target))
        .map(({ spec }) => `${file} imports ${spec}`));
      expect(bad).toEqual([]);
    });
  }
});
