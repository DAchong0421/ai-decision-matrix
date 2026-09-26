import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import analyze from '../api/analyze.js';

const here = dirname(fileURLToPath(import.meta.url));
const page = await readFile(resolve(here, '../dist/index.html'));

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
  if (path === '/api/analyze') {
    try {
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
      const webRequest = new Request(`http://localhost${request.url ?? '/api/analyze'}`, {
        method: request.method,
        headers: request.headers,
        body: hasBody ? Readable.toWeb(request) : undefined,
        duplex: hasBody ? 'half' : undefined,
      });
      const result = await analyze.fetch(webRequest);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: '服务暂时不可用。' }));
    }
    return;
  }
  if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(page);
    return;
  }
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

server.listen(Number(process.env.PORT ?? 10000), '0.0.0.0');
