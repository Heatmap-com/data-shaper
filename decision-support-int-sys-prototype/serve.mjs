#!/usr/bin/env node
// Static server for the query-tool prototype. Browsers block fetch() of JSON over file://.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8765;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = decodeURIComponent(url.pathname);
  const file = normalize(join(root, path));
  if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      if (!path.endsWith('/')) {
        send(res, 301, 'text/plain', '', { location: `${path}/${url.search}` });
        return;
      }
      send(res, 200, 'text/html; charset=utf-8', await readFile(join(file, 'index.html')));
      return;
    }
    const body = await readFile(file);
    send(res, 200, `${types[extname(file)] ?? 'application/octet-stream'}; charset=utf-8`, body);
  } catch {
    send(res, 404, 'text/plain', 'not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`query tool: http://127.0.0.1:${port}/`));
