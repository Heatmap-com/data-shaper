/**
 * HTTP for the Kimi adapter. Knows the descriptor's auth and version header.
 * Does not know what a project is.
 */

export function entries(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  for (const key of ['items', 'data', 'memories', 'memory_stores', 'agents', 'environments']) {
    if (Array.isArray(body[key])) return body[key];
  }
  return [];
}

export function nextPage(body) {
  const token = body?.next_page_token ?? body?.nextPageToken;
  return typeof token === 'string' && token ? token : '';
}

export function fillRoute(template, params) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = params[key];
    if (typeof value !== 'string' || !value) throw new Error(`route is missing ${key}`);
    return encodeURIComponent(value);
  });
}

/**
 * @param {object} descriptor
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof fetch} http
 * @param {'GET'|'POST'|'PATCH'} method
 * @param {string} routePath
 * @param {{ body?: object, query?: Record<string, string> }} [options]
 */
export async function request(descriptor, env, http, method, routePath, options = {}) {
  const key = env[descriptor.apiKeyEnv];
  if (!key) throw new Error(`missing ${descriptor.apiKeyEnv}`);
  const base = (env[descriptor.baseUrlEnv] || descriptor.defaultBaseUrl).replace(/\/$/, '');
  const query = options.query
    ? new URLSearchParams(Object.entries(options.query).filter(([, value]) => value != null && value !== ''))
    : null;
  const url = `${base}${routePath}${query && [...query.keys()].length ? `?${query}` : ''}`;
  const response = await http(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      [descriptor.versionHeader]: descriptor.version,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
  }
  if (!response.ok) {
    const detail = JSON.stringify(parsed).slice(0, 500);
    throw new Error(`provider request failed (${response.status}): ${detail}${hostHint(response.status, detail)}`);
  }
  return parsed;
}

function hostHint(status, detail) {
  if (status === 404 && detail.includes('url.not_found')) {
    return ' Hosted projects are served by https://api.moonshot.cn. This host does not expose them.';
  }
  return '';
}

/**
 * Bytes, not JSON. Used for a session file download, which is the file itself.
 */
export async function requestBuffer(descriptor, env, http, method, routePath, options = {}) {
  const key = env[descriptor.apiKeyEnv];
  if (!key) throw new Error(`missing ${descriptor.apiKeyEnv}`);
  const base = (env[descriptor.baseUrlEnv] || descriptor.defaultBaseUrl).replace(/\/$/, '');
  const query = options.query
    ? new URLSearchParams(Object.entries(options.query).filter(([, value]) => value != null && value !== ''))
    : null;
  const url = `${base}${routePath}${query && [...query.keys()].length ? `?${query}` : ''}`;
  const response = await http(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      [descriptor.versionHeader]: descriptor.version,
    },
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`provider request failed (${response.status}): ${buffer.toString('utf8').slice(0, 500)}`);
  }
  return buffer;
}

export async function listAll(descriptor, env, http, routePath) {
  const all = [];
  let pageToken = '';
  for (let page = 0; page < 50; page++) {
    const body = await request(descriptor, env, http, 'GET', routePath, {
      query: pageToken ? { page_token: pageToken } : undefined,
    });
    all.push(...entries(body));
    pageToken = nextPage(body);
    if (!pageToken) break;
  }
  return all;
}
