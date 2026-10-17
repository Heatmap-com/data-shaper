import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Send the prompt. The port returns whatever files the session wrote.
 *
 * @param {import('../ports/remote-project.mjs').RemoteProjectPort} port
 * @param {string} projectId
 * @param {{ prompt: string, expectPaths: string[], title?: string }} request
 */
export async function runAnalysis(port, projectId, request) {
  if (typeof port?.runPrompt !== 'function') throw new Error('project port is missing runPrompt');
  const prompt = request?.prompt?.trim() ?? '';
  if (!prompt) throw new Error('prompt is required');
  if (!projectId) throw new Error('project id is required');
  return port.runPrompt(projectId, {
    prompt,
    expectPaths: request.expectPaths ?? [],
    title: request.title,
  });
}

/**
 * Save returned reports next to each other. The remote directory is dropped
 * so `enhanced/Report.md` becomes `<outDir>/Report.md`.
 *
 * @param {string} outDir
 * @param {{ path: string, body: Buffer | string }[]} files
 * @param {string} [notes]
 * @returns {Promise<string[]>} absolute paths written
 */
export async function saveReports(outDir, files, notes) {
  await mkdir(outDir, { recursive: true });
  const written = [];
  const seen = new Set();
  for (const file of files) {
    const name = localName(file.path);
    if (seen.has(name)) continue;
    seen.add(name);
    const dest = path.join(outDir, name);
    const body = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body ?? '', 'utf8');
    await writeFile(dest, body);
    written.push(dest);
  }
  if (notes?.trim()) {
    const dest = path.join(outDir, 'response.md');
    await writeFile(dest, notes.endsWith('\n') ? notes : `${notes}\n`);
    written.push(dest);
  }
  return written;
}

function localName(remotePath) {
  const normalized = String(remotePath ?? '').replace(/\\/g, '/');
  if (!normalized || normalized.includes('..')) throw new Error(`refusing to save ${remotePath}`);
  const name = path.posix.basename(normalized);
  if (!name || name === '.' || name === '..') throw new Error(`refusing to save ${remotePath}`);
  return name;
}
