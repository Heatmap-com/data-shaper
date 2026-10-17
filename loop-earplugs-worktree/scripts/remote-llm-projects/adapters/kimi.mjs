import { fillRoute, listAll, request, requestBuffer } from './kimi-http.mjs';

/**
 * Kimi open-platform adapter. A project is a memory store. A prompt run is a
 * hosted-agent session with that store mounted. Chat-sidebar Projects have
 * no public API.
 *
 * @param {object} descriptor contents of descriptors/kimi.json
 * @param {{ fetch?: typeof fetch, env?: NodeJS.ProcessEnv, log?: (line: string) => void, sleep?: (ms: number) => Promise<void> }} [deps]
 * @returns {import('../ports/remote-project.mjs').RemoteProjectPort}
 */
export function createAdapter(descriptor, deps = {}) {
  const http = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  return { createProject, ensureProject, putFile, runPrompt };

  async function createProject(projectRequest) {
    const name = storedName(projectRequest.name, descriptor.name);
    const description = clip(projectRequest.instructions || projectRequest.name, descriptor.descriptionMaxLength);
    const store = await request(descriptor, env, http, 'POST', descriptor.routes.memoryStores, {
      body: { name, description },
    });
    const id = store?.id;
    if (typeof id !== 'string' || !id) throw new Error('provider response did not include an id');

    try {
      for (const file of seedFiles(descriptor, name, projectRequest.instructions)) {
        assertByteLength(Buffer.from(file.content, 'utf8'), descriptor.maxFileBytes, file.path);
        await request(descriptor, env, http, 'POST', fillRoute(descriptor.routes.memories, { storeId: id }), {
          body: { path: file.path, content: Buffer.from(file.content, 'utf8').toString('base64') },
        });
      }
    } catch (err) {
      throw new Error(`${err.message} (project ${id} was created)`);
    }
    return { id, name };
  }

  async function ensureProject(request) {
    const name = storedName(request.name, descriptor.name);
    const stores = await listAll(descriptor, env, http, descriptor.routes.memoryStores);
    const found = stores.find((item) => itemName(item) === name);
    if (found && (found.archived || found.status === 'archived')) {
      throw new Error(`project ${name} is archived and the name cannot be reused`);
    }
    const id = itemId(found);
    if (id) return { id, name };
    return createProject(request);
  }

  async function putFile(projectId, file) {
    assertRemotePath(file?.path);
    const body = asBuffer(file.body);
    assertByteLength(body, descriptor.maxFileBytes, file.path);
    const content = body.toString('base64');
    const memoriesRoute = fillRoute(descriptor.routes.memories, { storeId: projectId });
    let current = await findMemory(projectId, file.path);
    if (!current) {
      try {
        await request(descriptor, env, http, 'POST', memoriesRoute, { body: { path: file.path, content } });
        return { path: file.path, updated: false };
      } catch (err) {
        if (!/\(409\)/.test(err.message)) throw err;
        current = await findMemory(projectId, file.path);
      }
    }
    const memoryId = itemId(current);
    if (!memoryId) throw new Error(`could not store ${file.path}`);
    const full = await request(
      descriptor,
      env,
      http,
      'GET',
      fillRoute(descriptor.routes.memory, { storeId: projectId, memoryId }),
    );
    const sha = full?.content_sha256;
    if (typeof sha !== 'string' || !sha) throw new Error(`provider did not return content_sha256 for ${file.path}`);
    await request(descriptor, env, http, 'PATCH', fillRoute(descriptor.routes.memory, { storeId: projectId, memoryId }), {
      body: { content, content_sha256: sha },
    });
    return { path: file.path, updated: true };
  }

  async function runPrompt(projectId, promptRequest) {
    const run = descriptor.run;
    if (!run?.agentName || !run.model) throw new Error('provider descriptor has no run configuration');
    const prompt = promptRequest?.prompt?.trim() ?? '';
    if (!prompt) throw new Error('prompt is required');

    const agentId = await ensureAgent(run);
    const environmentId = await ensureEnvironment(run);
    log(`starting session on ${agentId}`);
    const session = await request(descriptor, env, http, 'POST', descriptor.routes.sessions, {
      body: {
        agent_id: agentId,
        environment_id: environmentId,
        title: clip(promptRequest.title || run.agentName, 256),
        resources: [
          {
            type: 'memory_store',
            memory_store_id: projectId,
            access: run.access,
            instructions: run.mountInstructions,
          },
        ],
      },
    });
    const sessionId = itemId(session);
    if (!sessionId) throw new Error('provider response did not include a session id');

    await request(descriptor, env, http, 'POST', fillRoute(descriptor.routes.events, { sessionId }), {
      body: { events: [{ type: 'user.message', data: { content: [{ type: 'text', text: prompt }] } }] },
    });
    log(`session ${sessionId} started`);
    const outcome = await waitUntilDone(sessionId, run);
    const files = await readWrittenFiles(projectId, sessionId, promptRequest.expectPaths ?? [], run);
    return { id: sessionId, text: outcome.text, stopReason: outcome.stopReason, files };
  }

  async function findMemory(projectId, filePath) {
    const items = await listAll(descriptor, env, http, fillRoute(descriptor.routes.memories, { storeId: projectId }));
    return items.find((item) => item?.path === filePath);
  }

  async function ensureAgent(run) {
    const agents = await listAll(descriptor, env, http, descriptor.routes.agents);
    const existing = agents.find((item) => itemName(item) === run.agentName);
    const existingId = itemId(existing);
    if (existingId) return existingId;
    const created = await request(descriptor, env, http, 'POST', descriptor.routes.agents, {
      body: { name: run.agentName, model: { id: run.model }, system: run.system },
    });
    const id = itemId(created);
    if (!id) throw new Error('provider response did not include an agent id');
    return id;
  }

  async function ensureEnvironment(run) {
    const environments = await listAll(descriptor, env, http, descriptor.routes.environments);
    const existing = environments.find((item) => itemName(item) === run.environmentName);
    let id = itemId(existing);
    if (!id) {
      const created = await request(descriptor, env, http, 'POST', descriptor.routes.environments, {
        body: { name: run.environmentName, config: run.environmentConfig },
      });
      id = itemId(created);
      if (!id) throw new Error('provider response did not include an environment id');
    }
    await waitUntilReady(id, run);
    return id;
  }

  async function waitUntilReady(environmentId, run) {
    const polls = pollCount(run);
    const routePath = fillRoute(descriptor.routes.environment, { environmentId });
    for (let i = 0; i < polls; i++) {
      const body = await request(descriptor, env, http, 'GET', routePath);
      const status = buildStatus(body);
      log(`environment ${environmentId} ${status ?? 'unknown'}`);
      if (status === 'ready') return;
      if (status === 'failed') {
        log(`environment ${environmentId} build failed; the session will use the last ready version`);
        return;
      }
      await sleep(run.pollIntervalMs);
    }
    throw new Error(`environment ${environmentId} was not ready within ${run.timeoutMs}ms`);
  }

  async function waitUntilDone(sessionId, run) {
    const polls = pollCount(run);
    const eventsRoute = fillRoute(descriptor.routes.events, { sessionId });
    for (let i = 0; i < polls; i++) {
      const session = await request(descriptor, env, http, 'GET', fillRoute(descriptor.routes.session, { sessionId }));
      if (session?.status === 'terminated') throw new Error(`session ${sessionId} terminated before the reports were written`);
      const events = await listAll(descriptor, env, http, eventsRoute);
      if ((events ?? []).some((event) => event?.type === 'session.status' && event.data?.status === 'terminated')) {
        throw new Error(`session ${sessionId} terminated before the reports were written`);
      }
      const state = turnFinished(events);
      log(`session ${sessionId} ${session?.status ?? 'unknown'}`);
      if (state === 'done') {
        return { text: assistantText(events), stopReason: stopReason(events) };
      }
      await sleep(run.pollIntervalMs);
    }
    throw new Error(`analysis did not finish within ${run.timeoutMs}ms (session ${sessionId})`);
  }

  async function readWrittenFiles(projectId, sessionId, expectPaths, run) {
    const listed = await listAll(descriptor, env, http, fillRoute(descriptor.routes.memories, { storeId: projectId }));
    const wanted = new Set(expectPaths);
    for (const item of listed) {
      const filePath = item?.path;
      if (typeof filePath === 'string' && (run.outputPrefixes ?? []).some((prefix) => filePath.startsWith(prefix))) {
        wanted.add(filePath);
      }
    }
    const files = [];
    for (const filePath of wanted) {
      const item = listed.find((entry) => entry?.path === filePath);
      if (!item) continue;
      files.push(await readMemory(projectId, item));
    }
    const missing = expectPaths.filter((filePath) => !files.some((file) => file.path === filePath));
    if (missing.length) {
      log(`memory store is missing ${missing.join(', ')}; checking the session files`);
      files.push(...(await readSessionFiles(sessionId, missing, run)));
    }
    return files;
  }

  async function readMemory(projectId, item) {
    const memoryId = itemId(item);
    const full = await request(
      descriptor,
      env,
      http,
      'GET',
      fillRoute(descriptor.routes.memory, { storeId: projectId, memoryId }),
    );
    if (typeof full?.content !== 'string') throw new Error(`provider file had no content for ${item.path}`);
    return { path: item.path, body: Buffer.from(full.content, 'base64') };
  }

  async function readSessionFiles(sessionId, missing, run) {
    const found = [];
    const prefixes = ['enhanced', 'output', ...(run.outputPrefixes ?? []).map((prefix) => prefix.replace(/\/$/, ''))];
    let nodes = [];
    for (const prefix of [...new Set(prefixes)]) {
      try {
        const body = await request(descriptor, env, http, 'GET', fillRoute(descriptor.routes.filesystem, { sessionId }), {
          query: { prefix },
        });
        nodes.push(...(Array.isArray(body) ? body : (body.items ?? body.data ?? [])));
      } catch (err) {
        log(`session file list failed: ${err.message}`);
      }
    }
    for (const node of nodes) {
      if (node?.is_dir || typeof node?.path !== 'string') continue;
      const matches = missing.some((filePath) => node.path === filePath || node.path.endsWith(`/${filePath.split('/').pop()}`));
      if (!matches) continue;
      try {
        const body = await requestBuffer(descriptor, env, http, 'GET', fillRoute(descriptor.routes.filesystemRaw, { sessionId }), {
          query: { path: node.path },
        });
        if (!body.length) continue;
        const remotePath = missing.find((filePath) => node.path.endsWith(filePath.split('/').pop())) ?? node.path;
        found.push({ path: remotePath, body });
      } catch (err) {
        log(`session file download failed: ${err.message}`);
      }
    }
    return found;
  }
}

/**
 * A turn is finished once the session has been running and has then gone
 * idle with a stop reason. The initial idle, before any work, does not count.
 * Event order does not matter.
 *
 * @param {object[]} events
 * @returns {'done' | 'pending'}
 */
export function turnFinished(events) {
  let sawRunning = false;
  let sawStop = false;
  for (const event of events ?? []) {
    if (event?.type !== 'session.status') continue;
    if (event.data?.status === 'running') sawRunning = true;
    if (event.data?.status === 'idle' && event.data?.stop_reason) sawStop = true;
  }
  return sawRunning && sawStop ? 'done' : 'pending';
}

function assistantText(events) {
  const parts = [];
  for (const event of events ?? []) {
    if (event?.type !== 'agent.message' && event?.type !== 'assistant.message') continue;
    parts.push(textOf(event.data));
  }
  return parts.filter(Boolean).join('\n').trim();
}

function textOf(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (typeof data.text === 'string') return data.text;
  if (typeof data.content === 'string') return data.content;
  if (Array.isArray(data.content)) {
    return data.content.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('');
  }
  return '';
}

function stopReason(events) {
  let reason = '';
  for (const event of events ?? []) {
    if (event?.type === 'session.status' && event.data?.status === 'idle' && event.data?.stop_reason) {
      reason = event.data.stop_reason;
    }
  }
  return reason;
}

function buildStatus(body) {
  return body?.build_status ?? body?.latest_version?.build_status ?? body?.version?.build_status ?? null;
}

function pollCount(run) {
  return Math.max(1, Math.ceil(run.timeoutMs / Math.max(run.pollIntervalMs, 1)));
}

function itemId(item) {
  const id = item?.id ?? item?.memory_id;
  return typeof id === 'string' ? id : '';
}

function itemName(item) {
  const name = item?.name ?? item?.title;
  return typeof name === 'string' ? name : '';
}

function asBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  throw new Error('file body must be a string or a buffer');
}

function assertByteLength(body, maxBytes, filePath) {
  if (body.length > maxBytes) throw new Error(`${filePath} is ${body.length} bytes; this provider allows ${maxBytes}`);
}

function assertRemotePath(filePath) {
  if (
    typeof filePath !== 'string' ||
    !filePath ||
    filePath.startsWith('/') ||
    filePath.includes('\\') ||
    filePath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`path cannot be stored: ${filePath}`);
  }
}

/**
 * @param {string} requested
 * @param {{ maxLength: number, pattern: string }} rule
 */
export function storedName(requested, rule) {
  let name = requested.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-');
  name = name.replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  if (name.length > rule.maxLength) name = name.slice(0, rule.maxLength).replace(/[-_]+$/g, '');
  if (!new RegExp(rule.pattern, 'u').test(name)) {
    throw new Error(`name ${JSON.stringify(requested)} cannot be stored by this provider`);
  }
  return name;
}

function clip(text, max) {
  const value = String(text ?? '').trim();
  return value.length <= max ? value : value.slice(0, max);
}

function seedFiles(descriptor, name, instructions) {
  const { readme, index, instructions: instructionsFile } = descriptor.files;
  const paths = [readme.path, index.path];
  if (instructions) paths.push(instructionsFile.path);
  const files = paths.map((filePath) => `- ${filePath}`).join('\n');
  const written = [
    { path: readme.path, content: fill(readme.content, { name, files }) },
    { path: index.path, content: fill(index.content, { name, files }) },
  ];
  if (instructions) {
    written.push({ path: instructionsFile.path, content: fill(instructionsFile.content, { name, files, instructions }) });
  }
  return written;
}

function fill(template, values) {
  return template.replace(/\{(name|files|instructions)\}/g, (_, key) => values[key] ?? '');
}
