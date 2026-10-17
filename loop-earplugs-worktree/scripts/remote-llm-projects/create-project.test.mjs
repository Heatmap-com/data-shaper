import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { parseArgs } from './args.mjs';
import { createAdapter } from './adapters/kimi.mjs';
import { createProject } from './application/create-project.mjs';
import { main } from './create-project.mjs';
import { loadProjectPort } from './load-port.mjs';

const descriptor = JSON.parse(
  await readFile(new URL('./descriptors/kimi.json', import.meta.url), 'utf8'),
);

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe('createProject', () => {
  it('trims the request and returns the port result', async () => {
    const port = {
      createProject: vi.fn(async (request) => ({ id: 'p1', name: request.name })),
    };
    const project = await createProject(port, { name: '  Ceremonia  ', instructions: '  be precise  ' });
    expect(port.createProject).toHaveBeenCalledWith({ name: 'Ceremonia', instructions: 'be precise' });
    expect(project).toEqual({ id: 'p1', name: 'Ceremonia' });
  });

  it('rejects a blank name before calling the port', async () => {
    const port = { createProject: vi.fn() };
    await expect(createProject(port, { name: '   ' })).rejects.toThrow('name is required');
    expect(port.createProject).not.toHaveBeenCalled();
  });
});

describe('kimi adapter', () => {
  it('creates a memory store and seeds the instruction files', async () => {
    const calls = [];
    const fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) return jsonResponse(201, { id: 'mem_1' });
      return jsonResponse(201, { id: `file_${calls.length}` });
    });
    const port = createAdapter(descriptor, { fetch, env: { KIMI_API_KEY: 'secret-key' } });

    const project = await port.createProject({
      name: 'Ceremonia Site',
      instructions: 'Cite the file a number came from.',
    });

    expect(project).toEqual({ id: 'mem_1', name: 'Ceremonia-Site' });
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.moonshot.cn/v1/memory-stores',
      'https://api.moonshot.cn/v1/memory-stores/mem_1/memories',
      'https://api.moonshot.cn/v1/memory-stores/mem_1/memories',
      'https://api.moonshot.cn/v1/memory-stores/mem_1/memories',
    ]);
    const headers = calls[0].init.headers;
    expect(headers.Authorization).toBe('Bearer secret-key');
    expect(headers['kimi-api-version']).toBe('2026-09-01-beta');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ name: 'Ceremonia-Site' });

    const bodies = calls.slice(1).map((call) => JSON.parse(call.init.body));
    expect(bodies.map((body) => body.path)).toEqual(['README.md', 'index.md', 'instructions.md']);
    const instructions = Buffer.from(bodies[2].content, 'base64').toString('utf8');
    expect(instructions).toContain('Cite the file a number came from.');
    const index = Buffer.from(bodies[1].content, 'base64').toString('utf8');
    expect(index).toContain('- instructions.md');
  });

  it('uses the base url from the environment and does not echo the key on failure', async () => {
    const fetch = vi.fn(async () => jsonResponse(401, { error: 'unauthorized' }));
    const port = createAdapter(descriptor, {
      fetch,
      env: { KIMI_API_KEY: 'secret-key', KIMI_API_BASE_URL: 'https://api.moonshot.ai/' },
    });
    await expect(port.createProject({ name: 'Ceremonia' })).rejects.toThrow(/401/);
    expect(fetch.mock.calls[0][0]).toBe('https://api.moonshot.ai/v1/memory-stores');
    try {
      await port.createProject({ name: 'Ceremonia' });
    } catch (err) {
      expect(err.message).not.toContain('secret-key');
    }
  });

  it('names the missing key and does not call the network', async () => {
    const fetch = vi.fn();
    const port = createAdapter(descriptor, { fetch, env: {} });
    await expect(port.createProject({ name: 'Ceremonia' })).rejects.toThrow('missing KIMI_API_KEY');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('loadProjectPort', () => {
  it('rejects an id that is not a descriptor name', async () => {
    await expect(loadProjectPort('../kimi')).rejects.toThrow('unknown provider');
    await expect(loadProjectPort('not-a-provider')).rejects.toThrow('unknown provider');
  });
});

describe('cli', () => {
  it('parses the three flags', () => {
    expect(parseArgs(['--provider', 'kimi', '--name', 'Ceremonia', '--instructions', 'be precise'])).toEqual({
      provider: 'kimi',
      name: 'Ceremonia',
      instructions: 'be precise',
    });
  });

  it('prints the project from whatever port the provider id loads', async () => {
    const lines = [];
    const log = console.log;
    console.log = (line) => lines.push(line);
    const code = await main(['--provider', 'kimi', '--name', 'Ceremonia'], {
      fetch: vi.fn(async (url) =>
        url.endsWith('/memories') ? jsonResponse(201, { id: 'file_1' }) : jsonResponse(201, { id: 'mem_9' }),
      ),
      env: { KIMI_API_KEY: 'secret-key' },
    });
    console.log = log;
    expect(code).toBe(0);
    expect(JSON.parse(lines[0])).toEqual({ provider: 'kimi', id: 'mem_9', name: 'Ceremonia' });
  });
});
