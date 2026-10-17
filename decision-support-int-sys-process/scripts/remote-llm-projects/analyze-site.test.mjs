import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseArgs } from './analyze-args.mjs';
import { createAdapter, turnFinished } from './adapters/kimi.mjs';
import { renderPrompt } from './application/prompt.mjs';
import { runAnalysis, saveReports } from './application/run-analysis.mjs';
import { collectSite } from './application/site-bundle.mjs';
import { loadReportSpecs, reportPattern } from './application/report-specs.mjs';
import { uploadSite } from './application/upload-site.mjs';
import { main } from './analyze-site.mjs';

const STAGES = fileURLToPath(new URL('../../orchestration/stages', import.meta.url));

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

const doneEvents = [
  { type: 'session.status', data: { status: 'idle' } },
  { type: 'session.status', data: { status: 'running' } },
  { type: 'agent.message', data: { content: [{ type: 'text', text: 'Wrote the three reports.' }] } },
  { type: 'session.status', data: { status: 'idle', stop_reason: 'end_turn' } },
];

describe('turnFinished', () => {
  it('ignores the idle state from before the turn starts', () => {
    expect(turnFinished([{ type: 'session.status', data: { status: 'idle' } }])).toBe('pending');
    expect(turnFinished(doneEvents)).toBe('done');
  });
});

describe('kimi files and run', () => {
  const env = { KIMI_API_KEY: 'secret-key' };

  it('stores a new file and replaces one that is already there', async () => {
    const calls = [];
    const fetch = vi.fn(async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body });
      if (init?.method === 'GET' && calls.filter((call) => call.method === 'GET').length === 1) {
        return jsonResponse(200, { items: [] });
      }
      if (init?.method === 'POST') return jsonResponse(201, { id: 'memfile_1' });
      if (init?.method === 'GET') {
        return jsonResponse(200, {
          items: [{ id: 'memfile_1', path: 'style-guide.md' }],
          content_sha256: 'sha-1',
          content: Buffer.from('old', 'utf8').toString('base64'),
        });
      }
      return jsonResponse(200, { id: 'memfile_1' });
    });
    const port = createAdapter(descriptor, { fetch, env });

    const created = await port.putFile('mem_1', { path: 'style-guide.md', body: 'new guide' });
    expect(created).toEqual({ path: 'style-guide.md', updated: false });

    const replaced = await port.putFile('mem_1', { path: 'style-guide.md', body: 'newer guide' });
    expect(replaced).toEqual({ path: 'style-guide.md', updated: true });
    const patch = JSON.parse(calls.find((call) => call.method === 'PATCH').body);
    expect(patch.content_sha256).toBe('sha-1');
    expect(Buffer.from(patch.content, 'base64').toString('utf8')).toBe('newer guide');
    expect(JSON.stringify(calls)).not.toContain('secret-key');
  });

  it('replaces a file when create races to a conflict', async () => {
    let listed = false;
    const fetch = vi.fn(async (url, init) => {
      if (init?.method === 'POST') return jsonResponse(409, { error: 'conflict' });
      if (!listed) {
        listed = true;
        return jsonResponse(200, { items: [] });
      }
      if (url.endsWith('/memories')) return jsonResponse(200, { items: [{ id: 'memfile_1', path: 'style-guide.md' }] });
      if (init?.method === 'GET') return jsonResponse(200, { content_sha256: 'sha-2', content: '' });
      return jsonResponse(200, {});
    });
    const port = createAdapter(descriptor, { fetch, env });
    const result = await port.putFile('mem_1', { path: 'style-guide.md', body: 'guide' });
    expect(result.updated).toBe(true);
  });

  it('rejects a path the provider would refuse, without a request', async () => {
    const fetch = vi.fn();
    const port = createAdapter(descriptor, { fetch, env });
    await expect(port.putFile('mem_1', { path: 'data/../secret', body: 'x' })).rejects.toThrow(/path cannot be stored/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says when this host has no projects', async () => {
    const fetch = vi.fn(async () => jsonResponse(404, { error: 'url.not_found', url: '/v1/memory-stores' }));
    const port = createAdapter(descriptor, { fetch, env });
    await expect(port.ensureProject({ name: 'ceremonia' })).rejects.toThrow(/api\.moonshot\.cn/);
  });

  it('reuses a project with the same stored name', async () => {
    const fetch = vi.fn(async () => jsonResponse(200, { items: [{ id: 'mem_existing', name: 'ceremonia' }] }));
    const port = createAdapter(descriptor, { fetch, env });
    await expect(port.ensureProject({ name: 'ceremonia' })).resolves.toEqual({ id: 'mem_existing', name: 'ceremonia' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not recreate an archived project', async () => {
    const fetch = vi.fn(async () => jsonResponse(200, { items: [{ id: 'mem_old', name: 'ceremonia', archived: true }] }));
    const port = createAdapter(descriptor, { fetch, env });
    await expect(port.ensureProject({ name: 'ceremonia' })).rejects.toThrow(/archived/);
  });

  it('runs the prompt and reads the enhanced file back', async () => {
    const calls = [];
    let envPolls = 0;
    const fetch = vi.fn(async (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body });
      const pathname = new URL(url).pathname;
      if (method === 'GET' && pathname === '/v1/agents') {
        return jsonResponse(200, { items: [{ id: 'agent_1', name: 'report-analyst' }] });
      }
      if (method === 'GET' && pathname === '/v1/environments') {
        return jsonResponse(200, { items: [{ id: 'env_1', name: 'report-workspace' }] });
      }
      if (method === 'GET' && pathname === '/v1/environments/env_1') {
        envPolls += 1;
        return jsonResponse(200, { id: 'env_1', build_status: envPolls < 2 ? 'building' : 'ready' });
      }
      if (method === 'POST' && pathname === '/v1/sessions') return jsonResponse(200, { id: 'sesn_1' });
      if (method === 'POST' && pathname === '/v1/sessions/sesn_1/events') return jsonResponse(202, {});
      if (method === 'GET' && pathname === '/v1/sessions/sesn_1') return jsonResponse(200, { id: 'sesn_1', status: 'idle' });
      if (method === 'GET' && pathname === '/v1/sessions/sesn_1/events') return jsonResponse(200, { items: doneEvents });
      if (method === 'GET' && pathname === '/v1/memory-stores/mem_9/memories') {
        return jsonResponse(200, {
          items: [
            { id: 'file_9', path: 'enhanced/Ceremonia — Site Opportunity Report.md' },
            { id: 'file_8', path: 'reports/Ceremonia — Site Opportunity Report.md' },
          ],
        });
      }
      if (method === 'GET' && pathname === '/v1/memory-stores/mem_9/memories/file_9') {
        return jsonResponse(200, { content: Buffer.from('# Enhanced\n', 'utf8').toString('base64'), content_sha256: 'abc' });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const sleep = vi.fn(async () => {});
    const port = createAdapter(descriptor, { fetch, env, sleep });
    const result = await port.runPrompt('mem_9', {
      prompt: 'Read the data and write the three reports.',
      title: 'Ceremonia enhanced reports',
      expectPaths: ['enhanced/Ceremonia — Site Opportunity Report.md'],
    });

    expect(result).toMatchObject({ id: 'sesn_1', text: 'Wrote the three reports.', stopReason: 'end_turn' });
    expect(result.files).toHaveLength(1);
    expect(result.files[0].body.toString('utf8')).toBe('# Enhanced\n');
    expect(sleep).toHaveBeenCalledWith(5000);

    const session = JSON.parse(calls.find((call) => call.method === 'POST' && call.url.endsWith('/v1/sessions')).body);
    expect(session.resources[0]).toMatchObject({ type: 'memory_store', memory_store_id: 'mem_9', access: 'read_write' });
    const message = JSON.parse(calls.find((call) => call.url.endsWith('/events')).body);
    expect(message.events[0].data.content[0].text).toContain('write the three reports');
    expect(calls.some((call) => call.url.includes('/file_8'))).toBe(false);
  });
});

describe('site upload', () => {
  it('uploads the bundle, the three reports, and the style guide, and skips the project log', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'site-upload-'));
    try {
      const dataDir = path.join(root, 'data');
      const reportsDir = path.join(root, 'reports');
      await mkdir(dataDir);
      await mkdir(reportsDir);
      await writeFile(path.join(dataDir, '00_README_data_guide.md'), 'guide\n');
      await writeFile(
        path.join(dataDir, '00_site_profile.json'),
        JSON.stringify({
          site: 'Ceremonia',
          domain: 'ceremonia.com',
          currency: 'USD',
          analysed_page: { path: '/', label: 'Homepage' },
          report_window: { start: '2026-09-12', end: '2026-10-11' },
        }),
      );
      await writeFile(path.join(dataDir, '.anchors.json'), '{}\n');
      await writeFile(path.join(reportsDir, 'Ceremonia — Site Opportunity Report.md'), 'sor\n');
      await writeFile(path.join(reportsDir, 'Ceremonia — Today Opportunities.md'), 'today\n');
      await writeFile(path.join(reportsDir, 'Ceremonia — User Journey Opportunity Analysis.md'), 'journey\n');
      await writeFile(path.join(reportsDir, 'PROJECT-LOG.md'), 'log\n');
      const styleGuide = path.join(root, 'style-guide.md');
      await writeFile(styleGuide, 'style\n');

      const site = await collectSite({ slug: 'ceremonia', dataDir, reportsDir, styleGuide, reports: await loadReportSpecs(STAGES) });
      const template = await readFile(new URL('./prompts/enhance-reports.md', import.meta.url), 'utf8');
      const prompt = renderPrompt(template, site);
      expect(prompt).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
      expect(prompt).toContain('Research beyond the three reports');
      expect(prompt).toContain('enhanced/Ceremonia — Site Opportunity Report.md');
      expect(prompt).toContain('style-guide.md');
      expect(prompt).toContain('2026-09-12 to 2026-10-11');

      const puts = [];
      const lines = [];
      const port = {
        ensureProject: vi.fn(async (request) => ({ id: 'p1', name: request.name })),
        putFile: vi.fn(async (_id, file) => {
          puts.push(file.path);
          return { path: file.path, updated: false };
        }),
      };
      const uploaded = await uploadSite(port, { name: site.slug, files: site.files }, (line) => lines.push(line));
      expect(uploaded.project).toEqual({ id: 'p1', name: 'ceremonia' });
      expect(puts).toContain('data/00_README_data_guide.md');
      expect(puts).toContain('data/.anchors.json');
      expect(puts).toContain('reports/Ceremonia — Today Opportunities.md');
      expect(puts).toContain('style-guide.md');
      expect(puts).toContain('index.md');
      expect(puts).not.toContain('PROJECT-LOG.md');
      expect(lines.some((line) => line.startsWith('updating style-guide.md'))).toBe(true);

      const outDir = path.join(root, 'enhanced');
      const written = await saveReports(
        outDir,
        [{ path: 'enhanced/Ceremonia — Site Opportunity Report.md', body: '# Enhanced\n' }],
        'Changed the first finding.',
      );
      expect(await readFile(written[0], 'utf8')).toBe('# Enhanced\n');
      expect(await readFile(path.join(outDir, 'response.md'), 'utf8')).toContain('Changed the first finding.');
      await expect(saveReports(outDir, [{ path: '../secret.md', body: 'x' }])).rejects.toThrow(/refusing/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails before any upload when a report is missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'site-missing-'));
    try {
      await mkdir(path.join(root, 'data'));
      await mkdir(path.join(root, 'reports'));
      await writeFile(path.join(root, 'data', '00_README_data_guide.md'), 'guide\n');
      await writeFile(path.join(root, 'data', '00_site_profile.json'), '{"site":"Ceremonia"}');
      await expect(
        collectSite({
          slug: 'ceremonia',
          dataDir: path.join(root, 'data'),
          reportsDir: path.join(root, 'reports'),
          styleGuide: path.join(root, 'missing.md'),
          reports: await loadReportSpecs(STAGES),
        }),
      ).rejects.toThrow(/missing Site Opportunity Report/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('report specs from the stage descriptors', () => {
  it('lists the three client reports in document order', async () => {
    const specs = await loadReportSpecs(STAGES);
    expect(specs.map((spec) => spec.role)).toEqual(['Site Opportunity Report', 'Today Opportunities', 'User Journey Opportunity Analysis']);
    expect(specs[0].pattern.test('Sayii — Site Opportunity Report.md')).toBe(true);
    expect(specs[0].pattern.test('Sayii — Site Opportunity Report.pdf')).toBe(false);
  });

  it('escapes a title used as a file pattern', () => {
    expect(reportPattern('Q&A (beta)').test('X — Q&A (beta).md')).toBe(true);
  });

  it('refuses to collect a site with no report list', async () => {
    await expect(collectSite({ slug: 'x', dataDir: '/nope', reportsDir: '/nope', styleGuide: '/nope' })).rejects.toThrow(/reports are required/);
  });
});

describe('analyze-site cli', () => {
  it('parses the site command', () => {
    expect(parseArgs(['--provider', 'kimi', '--site', 'ceremonia', '--upload-only'])).toMatchObject({
      provider: 'kimi',
      site: 'ceremonia',
      uploadOnly: true,
    });
  });

  it('uploads and then sends the prompt through whatever port the provider id loads', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'analyze-cli-'));
    const lines = [];
    const log = console.log;
    const error = console.error;
    console.log = (line) => lines.push(line);
    console.error = () => {};
    try {
      await mkdir(path.join(root, 'data'));
      await mkdir(path.join(root, 'reports'));
      await writeFile(path.join(root, 'data', '00_README_data_guide.md'), 'guide\n');
      await writeFile(
        path.join(root, 'data', '00_site_profile.json'),
        JSON.stringify({
          site: 'Ceremonia',
          domain: 'ceremonia.com',
          currency: 'USD',
          analysed_page: { label: 'Homepage', path: '/' },
          report_window: { start: '2026-09-12', end: '2026-10-11' },
        }),
      );
      const names = [
        'Ceremonia — Site Opportunity Report.md',
        'Ceremonia — Today Opportunities.md',
        'Ceremonia — User Journey Opportunity Analysis.md',
      ];
      for (const name of names) await writeFile(path.join(root, 'reports', name), 'source\n');
      await writeFile(path.join(root, 'style-guide.md'), 'style\n');

      const runPrompt = vi.fn(async () => ({
        id: 'sesn_1',
        text: 'note',
        stopReason: 'end_turn',
        files: names.map((name) => ({ path: `enhanced/${name}`, body: Buffer.from(`# ${name}\n`) })),
      }));
      const code = await main(
        [
          '--provider',
          'kimi',
          '--site',
          'ceremonia',
          '--data',
          path.join(root, 'data'),
          '--reports',
          path.join(root, 'reports'),
          '--style-guide',
          path.join(root, 'style-guide.md'),
          '--out',
          path.join(root, 'out'),
        ],
        {
          loadProjectPort: async () => ({
            ensureProject: async () => ({ id: 'p1', name: 'ceremonia' }),
            putFile: async () => ({ path: 'x', updated: false }),
            runPrompt,
          }),
        },
      );
      expect(code).toBe(0);
      expect(runPrompt).toHaveBeenCalledTimes(1);
      const request = runPrompt.mock.calls[0][1];
      expect(request.expectPaths).toEqual(names.map((name) => `enhanced/${name}`));
      expect(request.prompt).toContain('Research beyond the three reports');
      expect(await readFile(path.join(root, 'out', names[0]), 'utf8')).toContain('# Ceremonia — Site Opportunity Report.md');
      const summary = JSON.parse(lines.at(-1));
      expect(summary.project.id).toBe('p1');
      expect(summary.missing).toEqual([]);
    } finally {
      console.log = log;
      console.error = error;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('runAnalysis', () => {
  it('rejects a blank prompt before calling the port', async () => {
    const port = { runPrompt: vi.fn() };
    await expect(runAnalysis(port, 'p1', { prompt: '   ' })).rejects.toThrow('prompt is required');
    expect(port.runPrompt).not.toHaveBeenCalled();
  });
});
