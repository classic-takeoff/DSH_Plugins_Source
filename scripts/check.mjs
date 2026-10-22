#!/usr/bin/env node
/**
 * End-to-end check of a running index source, the way DSH reads it.
 *
 *   node scripts/check.mjs [--url URL] [--spawn] [--root dist]
 *
 * With --spawn the static server is started for the duration of the check. It verifies the
 * HTTP contract (no redirect, JSON content type, strict UTF-8), runs the same validator DSH
 * runs, and fetches every icon the Discover tab would load.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { MarketIndexError, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';

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
const sources = JSON.parse(await fs.readFile(path.join(ROOT, 'sources', 'index.json'), 'utf8'));
const url = String(args.url ?? sources.indexUrl ?? 'http://127.0.0.1:8787/index.json');
const target = new URL(url);

const failures = [];
function check(ok, label, detail = '') {
  if (ok) console.log(`  ok   ${label}${detail === '' ? '' : `  (${detail})`}`);
  else {
    console.log(`  FAIL ${label}${detail === '' ? '' : `  (${detail})`}`);
    failures.push(label);
  }
}

async function waitForHealth(origin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/healthz', origin), { signal: AbortSignal.timeout(1000) });
      if (response.ok) return true;
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

let child;
if (args.spawn) {
  child = spawn(
    process.execPath,
    [path.join(ROOT, 'scripts', 'serve.mjs'), '--root', String(args.root ?? 'dist'), '--host', target.hostname, '--port', target.port],
    { cwd: ROOT, stdio: 'ignore' },
  );
  const ready = await waitForHealth(target.origin, 15_000);
  if (!ready) {
    console.error('server did not become ready');
    child.kill();
    process.exit(1);
  }
}

try {
  console.log(`checking ${url}`);

  const response = await fetch(url, { redirect: 'manual', headers: { accept: 'application/json' } });
  check(response.status === 200, 'HTTP 200', `status ${String(response.status)}`);
  check(response.redirected === false && response.status < 300, 'no redirect');
  const contentType = response.headers.get('content-type') ?? '';
  check(contentType.toLowerCase().startsWith('application/json'), 'content type is JSON', contentType || 'missing');

  const bytes = new Uint8Array(await response.arrayBuffer());
  check(bytes.byteLength > 0 && bytes.byteLength <= 128 * 1024 * 1024, 'body within maxBytes', `${(bytes.byteLength / 1024).toFixed(1)} KiB`);

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    check(false, 'body is strict UTF-8');
  }

  let document;
  let parsed;
  if (text !== undefined) {
    try {
      document = JSON.parse(text);
    } catch (error) {
      check(false, 'body is JSON', error.message);
    }
    if (document !== undefined) {
      try {
        parsed = parseMarketIndex(document, url);
        check(true, 'valid format 1', `${String(parsed.plugins.length)} plugins`);
      } catch (error) {
        if (error instanceof MarketIndexError) check(false, 'valid format 1', `${error.path} ${error.reason}`);
        else throw error;
      }
    }
  }

  if (parsed !== undefined) {
    const unsorted = parsed.plugins.filter((plugin, index) => {
      const order = document.plugins[index].versions.map((entry) => entry.version);
      return order.some((version, position) => position > 0 && semver.rcompare(order[position - 1], version) > 0);
    });
    check(unsorted.length === 0, 'versions are newest-first', unsorted.map((plugin) => plugin.name).join(', '));

    const icons = [...new Set(parsed.plugins.map((plugin) => plugin.icon))];
    const bad = [];
    for (const icon of icons) {
      try {
        const iconResponse = await fetch(icon, { redirect: 'manual' });
        const iconType = iconResponse.headers.get('content-type') ?? '';
        if (iconResponse.status !== 200 || !iconType.startsWith('image/')) bad.push(`${icon} -> ${String(iconResponse.status)} ${iconType}`);
      } catch (error) {
        bad.push(`${icon} -> ${error.message}`);
      }
    }
    check(bad.length === 0, `${String(icons.length)} icons load`, bad.join('; '));
  }

  const totalVersions = parsed?.plugins.reduce((total, plugin) => total + plugin.versions.length, 0) ?? 0;
  console.log('');
  if (failures.length === 0) {
    console.log(`PASS ${String(parsed.plugins.length)} plugins, ${String(totalVersions)} versions, ready for Plugins -> Discover`);
  } else {
    console.log(`FAILED ${String(failures.length)} check(s): ${failures.join(', ')}`);
    process.exitCode = 1;
  }
} finally {
  if (child !== undefined) child.kill();
}
