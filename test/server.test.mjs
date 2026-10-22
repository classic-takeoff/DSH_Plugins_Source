import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer } from '../lib/server.mjs';

async function fixtureRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-index-'));
  await fs.mkdir(path.join(root, 'icons'));
  await fs.writeFile(path.join(root, 'index.json'), '{"format":1}\n');
  await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><title>index</title>\n');
  await fs.writeFile(path.join(root, 'icons', 'plugin.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  return root;
}

test('static server: JSON contract, ETag revalidation, HEAD, 404, no redirects', async (t) => {
  const root = await fixtureRoot();
  const { server, url, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const origin = new URL(url).origin;

  const index = await fetch(url, { redirect: 'manual' });
  assert.equal(index.status, 200);
  assert.equal(index.redirected, false);
  assert.match(index.headers.get('content-type'), /^application\/json/u);
  const etag = index.headers.get('etag');
  assert.ok(etag);

  const revalidated = await fetch(url, { headers: { 'if-none-match': etag } });
  assert.equal(revalidated.status, 304);

  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const icon = await fetch(new URL('/icons/plugin.svg', origin));
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/svg+xml');

  const rootPage = await fetch(`${origin}/`);
  assert.equal(rootPage.status, 200);
  assert.match(await rootPage.text(), /<title>index<\/title>/u);

  const missing = await fetch(`${origin}/nope.json`);
  assert.equal(missing.status, 404);

  const traversal = await fetch(`${origin}/%2e%2e/package.json`);
  assert.equal(traversal.status, 404);

  const post = await fetch(url, { method: 'POST' });
  assert.equal(post.status, 405);

  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
});

test('static server: a missing file never redirects to a directory index', async (t) => {
  const root = await fixtureRoot();
  await fs.mkdir(path.join(root, 'docs'));
  const { url, close } = await startServer({ root, port: 0 });
  t.after(async () => {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const origin = new URL(url).origin;

  const dir = await fetch(`${origin}/docs`, { redirect: 'manual' });
  assert.equal(dir.status, 404);
  assert.equal(dir.redirected, false);
});
