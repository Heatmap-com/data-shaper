import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** @returns {import('../../ports/workspace.js').WorkspacePort} */
export function createWorkspace({ root }) {
  return {
    async runDir(jobId, stage, label) {
      const dir = path.join(root, jobId, stage, label);
      await mkdir(dir, { recursive: true });
      return dir;
    },
    async readJson(file) {
      try {
        return JSON.parse(await readFile(file, 'utf8'));
      } catch {
        return undefined;
      }
    },
  };
}
