import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { marketInstallTarget, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';
import {
  buildDocument,
  iconReference,
  loadConfig,
  packageSlug,
  PluginError,
  scanPlugins,
} from '../lib/plugins.mjs';

const COMMIT = 'a'.repeat(40);
const INDEX_URL = 'https://example.github.io/plugins/index.json';
const REPOSITORY = 'https://github.com/acme/plugins';

const config = {
  title: { en: 'Test market', 'zh-cn': '测试市场' },
  repository: REPOSITORY,
  indexUrl: INDEX_URL,
  metadata: {
    categories: { tools: { title: { en: 'Tools' } } },
    labels: { stable: { title: { en: 'Stable' } } },
    sortKeys: { featured: { title: { en: 'Featured' }, order: 'desc' } },
  },
};

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-plugins-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function makePlugin(root, folder, { manifest = {}, meta } = {}) {
  const dir = path.join(root, folder);
  await fs.mkdir(path.join(dir, 'lib'), { recursive: true });
  const pkg = {
    name: '@acme/hello',
    version: '1.0.0',
    description: 'Greets the model.',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    ...manifest,
  };
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  await fs.writeFile(path.join(dir, 'cordis.patch.yml'), '- insert: []\n');
  await fs.writeFile(path.join(dir, 'lib', 'index.js'), 'export default {}\n');
  if (meta !== undefined) await fs.writeFile(path.join(dir, 'dsh-index.json'), JSON.stringify(meta, null, 2));
  return dir;
}

function document(plugins) {
  return buildDocument({ config: loadConfig(config), plugins, commit: COMMIT, publishTimestamp: 1_760_000_000 });
}

test('scanPlugins reads a plugin folder and its display metadata', async (t) => {
  const root = await tempRoot(t);
  await makePlugin(root, 'dsh-hello', {
    manifest: { name: '@acme/dsh-hello', version: '1.2.3', engines: { dsh: '>=0.2.0' } },
    meta: { title: { en: 'Hello', 'zh-cn': '你好' }, category: 'tools', labels: ['stable'] },
  });
  const plugins = await scanPlugins(root);
  assert.equal(plugins.length, 1);
  const [plugin] = plugins;
  assert.equal(plugin.name, '@acme/dsh-hello');
  assert.equal(plugin.version, '1.2.3');
  assert.equal(plugin.folder, 'dsh-hello');
  assert.deepEqual(plugin.meta.title, { en: 'Hello', 'zh-cn': '你好' });
  assert.equal(iconReference(plugin), 'icons/acme-dsh-hello.svg');
});

test('scanPlugins rejects a folder that is not a DSH bundle', async (t) => {
  const root = await tempRoot(t);
  await makePlugin(root, 'not-a-bundle', { manifest: { dsh: undefined } });
  await assert.rejects(scanPlugins(root), (error) => error instanceof PluginError && error.path.includes('dsh.bundle.patch'));
});

test('scanPlugins rejects duplicate package names across folders', async (t) => {
  const root = await tempRoot(t);
  await makePlugin(root, 'one');
  await makePlugin(root, 'two');
  await assert.rejects(scanPlugins(root), /duplicates @acme\/hello/u);
});

test('scanPlugins rejects workspace: dependency ranges', async (t) => {
  const root = await tempRoot(t);
  await makePlugin(root, 'hello', { manifest: { dependencies: { '@acme/core': 'workspace:*' } } });
  await assert.rejects(scanPlugins(root), /workspace:/u);
});

test('buildDocument pins every plugin to the commit and its plugin folder', async (t) => {
  const root = await tempRoot(t);
  await makePlugin(root, 'dsh-hello', { manifest: { engines: { dsh: '>=0.2.0' } }, meta: { title: { en: 'Hello' }, category: 'tools' } });
  const parsed = parseMarketIndex(document(await scanPlugins(root)), INDEX_URL);
  const entry = parsed.plugins[0];
  assert.equal(entry.name, '@acme/hello');
  assert.deepEqual(entry.versions[0].source, {
    type: 'git',
    url: REPOSITORY,
    commit: COMMIT,
    path: 'plugins/dsh-hello',
  });
  assert.deepEqual(marketInstallTarget(entry.name, entry.versions[0]), {
    spec: `git+${REPOSITORY}.git#${COMMIT}&path:/plugins/dsh-hello`,
  });
  assert.deepEqual(entry.versions[0].engines, { dsh: '>=0.2.0' });
});

test('an empty plugins/ folder produces a valid index with no plugins', async (t) => {
  const root = await tempRoot(t);
  const parsed = parseMarketIndex(document(await scanPlugins(root)), INDEX_URL);
  assert.deepEqual(parsed.plugins, []);
});

test('loadConfig rejects unknown fields and non-https repositories', () => {
  assert.throws(() => loadConfig({ ...config, extra: true }), /not a supported field/u);
  assert.throws(() => loadConfig({ ...config, repository: 'http://github.com/acme/plugins' }), /https:/u);
  assert.throws(() => loadConfig({ ...config, repository: 'https://github.com/acme' }), /two path segments/u);
});

test('packageSlug keeps scoped names unique and path-safe', () => {
  assert.equal(packageSlug('@acme/dsh-hello'), 'acme-dsh-hello');
  assert.notEqual(packageSlug('@a/b'), packageSlug('@b/a'));
  assert.ok(!packageSlug('@acme/weird name!').match(/[^a-z0-9._-]/u));
});
