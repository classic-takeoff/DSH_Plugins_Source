#!/usr/bin/env node
/**
 * Serve the built index over HTTP.
 *
 *   node scripts/serve.mjs [--root dist] [--host 127.0.0.1] [--port 8787]
 *
 * DeepSeek Harness refuses redirects, so this server answers every path directly and never
 * rewrites a URL. Bind 0.0.0.0 to let another machine read the index.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../lib/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=', 2);
    const next = argv[index + 1];
    if (inline !== undefined) args[key] = inline;
    else if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      index++;
    } else args[key] = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(ROOT, args.root ?? 'dist');
const host = String(args.host ?? '127.0.0.1');
const port = Number(args.port ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error(`invalid --port: ${String(args.port)}`);
  process.exit(1);
}

try {
  await fs.access(path.join(root, 'index.json'));
} catch {
  console.error(`no index.json in ${root}; run: node scripts/build.mjs`);
  process.exit(1);
}

const { url, close } = await startServer({ root, host, port });
console.log(`serving ${path.relative(ROOT, root)} on http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${String(new URL(url).port)}`);
console.log(`index source: ${url}`);
console.log('paste that URL into DeepSeek Harness: Plugins -> Discover -> Add index source');
console.log('ctrl+c to stop');

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log('\nstopping');
    void close().then(() => process.exit(0));
  });
}
