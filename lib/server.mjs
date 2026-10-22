/** A small static file server: no redirects, no directory listings, correct content types. */
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';

const CONTENT_TYPES = new Map([
  ['.json', 'application/json; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
]);

/** Content type by extension; JSON and HTML are declared UTF-8 so clients never guess. */
export function contentTypeFor(file) {
  return CONTENT_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream';
}

function etagOf(body) {
  return `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 32)}"`;
}

function cacheControlFor(file) {
  const extension = path.extname(file).toLowerCase();
  return extension === '.json' || extension === '.html' ? 'no-cache' : 'public, max-age=300';
}

/** Plain-text response that also honours HEAD, which must not carry a body. */
function sendText(response, method, status, text, headers = {}) {
  const body = Buffer.from(text);
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    ...headers,
  });
  if (method === 'HEAD') response.end();
  else response.end(body);
}

async function resolveFile(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes('\u0000')) return undefined;
  const target = path.resolve(root, `.${decoded.endsWith('/') ? `${decoded}index.html` : decoded}`);
  if (target !== root && !target.startsWith(root + path.sep)) return undefined;
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) return path.join(target, 'index.html');
    return target;
  } catch {
    return undefined;
  }
}

/**
 * Listen on a static root.
 * @returns {Promise<{server: http.Server, url: string, close: () => Promise<void>}>} the bound URL,
 *   with `index.json` appended as the index source.
 */
export async function startServer({ root, host = '127.0.0.1', port = 8787 }) {
  const base = path.resolve(root);
  const server = http.createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      sendText(response, method, 405, 'method not allowed\n', { allow: 'GET, HEAD' });
      return;
    }
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    if (pathname === '/healthz') {
      const body = Buffer.from('{"ok":true}\n');
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      if (method === 'HEAD') response.end();
      else response.end(body);
      return;
    }

    const file = await resolveFile(base, pathname);
    if (file === undefined) {
      sendText(response, method, 404, `not found: ${pathname}\n`);
      return;
    }
    let body;
    try {
      body = await fs.readFile(file);
    } catch {
      sendText(response, method, 404, `not found: ${pathname}\n`);
      return;
    }
    const etag = etagOf(body);
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { etag, 'cache-control': cacheControlFor(file) }).end();
      return;
    }
    response.writeHead(200, {
      'content-type': contentTypeFor(file),
      'content-length': body.length,
      etag,
      'cache-control': cacheControlFor(file),
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    });
    if (method === 'HEAD') response.end();
    else response.end(body);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return {
    server,
    url: `http://${displayHost}:${String(actualPort)}/index.json`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
