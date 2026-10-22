import assert from 'node:assert/strict';
import test from 'node:test';
import { marketInstallTarget, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';
import {
  CatalogError,
  buildDocument,
  loadCatalog,
  npmVersionEntry,
  packageSlug,
  selectVersions,
} from '../lib/catalog.mjs';
import { monogramSvg } from '../lib/icons.mjs';

const INDEX_URL = 'http://127.0.0.1:8787/index.json';

function manifest(version, extra = {}) {
  return {
    name: '@acme/tools',
    version,
    description: 'Tools for things.',
    homepage: 'https://github.com/acme/tools#readme',
    repository: { type: 'git', url: 'git+https://github.com/acme/tools.git', directory: 'packages/tools' },
    engines: { dsh: '>=0.2.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    ...extra,
  };
}

function registryDocument(versions = ['1.0.0', '1.1.0', '1.2.0']) {
  return {
    name: '@acme/tools',
    'dist-tags': { latest: versions.at(-1) },
    versions: Object.fromEntries(versions.map((version) => [version, manifest(version)])),
    time: Object.fromEntries(versions.map((version, index) => [version, new Date(Date.UTC(2025, 0, 1 + index)).toISOString()])),
  };
}

function catalog(plugins) {
  return {
    title: { en: 'Test market', 'zh-cn': '测试市场' },
    metadata: { categories: { tools: { title: { en: 'Tools' } } } },
    plugins,
  };
}

function iconsFor(plugins) {
  return Object.fromEntries(plugins.map((plugin) => [plugin.name, `icons/${packageSlug(plugin.name)}.svg`]));
}

test('loadCatalog normalizes a string title and defaults versions to all', () => {
  const loaded = loadCatalog({ title: 'Market', plugins: [{ name: '@acme/tools' }] });
  assert.deepEqual(loaded.title, { en: 'Market' });
  assert.equal(loaded.plugins[0].versions, 'all');
  assert.equal(loaded.plugins[0].requiresBundle, true);
});

test('loadCatalog rejects duplicate names and uppercase language ids', () => {
  assert.throws(
    () => loadCatalog(catalog([{ name: '@acme/tools' }, { name: '@acme/tools' }])),
    (error) => error instanceof CatalogError && error.path === '$.plugins[1].name',
  );
  assert.throws(
    () => loadCatalog({ title: { en: 'x', 'zh-CN': 'y' }, plugins: [{ name: '@acme/tools' }] }),
    (error) => error instanceof CatalogError && error.reason.includes('lowercase language id'),
  );
});

test('selectVersions: all is newest-first, latest follows the dist-tag', () => {
  const document = registryDocument(['1.0.0', '1.2.0', '2.0.0-next.1', '1.1.0']);
  document['dist-tags'].latest = '1.2.0';
  const plugin = { name: '@acme/tools', versions: 'all' };
  assert.deepEqual(selectVersions(document, plugin), ['2.0.0-next.1', '1.2.0', '1.1.0', '1.0.0']);
  assert.deepEqual(selectVersions(document, { ...plugin, versions: 'latest' }), ['1.2.0']);
});

test('selectVersions: explicit list, deduplicated by order, honouring maxVersions', () => {
  const document = registryDocument();
  const plugin = { name: '@acme/tools', versions: ['1.0.0', '1.2.0', '1.1.0'], maxVersions: 2 };
  assert.deepEqual(selectVersions(document, plugin), ['1.2.0', '1.1.0']);
  assert.throws(
    () => selectVersions(document, { ...plugin, versions: ['9.9.9'] }),
    (error) => error instanceof CatalogError,
  );
});

test('npmVersionEntry carries the registry publish time, engines, and registry', () => {
  const document = registryDocument();
  const entry = npmVersionEntry(document, '1.1.0', { name: '@acme/tools', registry: 'https://registry.example.com' });
  assert.equal(entry.version, '1.1.0');
  assert.equal(entry.publishTimestamp, Math.floor(Date.parse(document.time['1.1.0']) / 1000));
  assert.deepEqual(entry.engines, { dsh: '>=0.2.0' });
  assert.deepEqual(entry.source, { type: 'npm', registry: 'https://registry.example.com' });
});

test('npmVersionEntry skips a version that is not a bundle unless told otherwise', () => {
  const document = registryDocument(['1.0.0']);
  document.versions['0.9.0'] = manifest('0.9.0', { dsh: undefined });
  document.time['0.9.0'] = '2024-12-01T00:00:00.000Z';
  assert.equal(npmVersionEntry(document, '0.9.0', { name: '@acme/tools', requiresBundle: true }), undefined);
  assert.equal(npmVersionEntry(document, '0.9.0', { name: '@acme/tools', requiresBundle: false }).version, '0.9.0');
});

test('buildDocument produces a document the real format-1 validator accepts', () => {
  const loaded = loadCatalog(catalog([{ name: '@acme/tools', category: 'tools', versions: 'all' }]));
  const document = buildDocument(loaded, { '@acme/tools': registryDocument() }, iconsFor(loaded.plugins));
  const parsed = parseMarketIndex(document, INDEX_URL);
  assert.equal(parsed.plugins.length, 1);
  assert.deepEqual(parsed.plugins[0].versions.map((entry) => entry.version), ['1.2.0', '1.1.0', '1.0.0']);
  assert.deepEqual(parsed.plugins[0].repository, {
    url: 'https://github.com/acme/tools',
    directory: 'packages/tools',
  });
  assert.deepEqual(parsed.plugins[0].metadata.keywords, []);
});

test('buildDocument skips non-bundle versions and fails when none remain', () => {
  const loaded = loadCatalog(catalog([{ name: '@acme/tools' }]));
  const document = registryDocument();
  document.versions['0.9.0'] = manifest('0.9.0', { dsh: undefined });
  document.time['0.9.0'] = '2024-12-01T00:00:00.000Z';
  const skipped = [];
  const built = buildDocument(loaded, { '@acme/tools': document }, iconsFor(loaded.plugins), {
    onSkipped: (name, version) => skipped.push(`${name}@${version}`),
  });
  assert.deepEqual(skipped, ['@acme/tools@0.9.0']);
  assert.ok(built.plugins[0].versions.every((entry) => entry.version !== '0.9.0'));

  const empty = registryDocument(['0.9.0']);
  empty.versions['0.9.0'] = manifest('0.9.0', { dsh: undefined });
  assert.throws(() => buildDocument(loaded, { '@acme/tools': empty }, iconsFor(loaded.plugins)), /no version with a dsh\.bundle/u);
});

test('git plugins install from a pinned commit with pnpm path syntax', () => {
  const commit = 'a'.repeat(40);
  const loaded = loadCatalog({
    title: 'Market',
    plugins: [{
      name: '@acme/tools',
      title: 'Tools',
      git: {
        url: 'https://github.com/acme/tools',
        path: 'packages/tools',
        versions: [{ version: '1.0.0', commit, publishTimestamp: 1_750_000_000 }],
      },
    }],
  });
  const document = buildDocument(loaded, {}, iconsFor(loaded.plugins));
  const parsed = parseMarketIndex(document, INDEX_URL);
  const entry = parsed.plugins[0].versions[0];
  assert.deepEqual(entry.source, { type: 'git', url: 'https://github.com/acme/tools', commit, path: 'packages/tools' });
  assert.deepEqual(marketInstallTarget(parsed.plugins[0].name, entry), {
    spec: `git+https://github.com/acme/tools.git#${commit}&path:/packages/tools`,
  });
});

test('git plugins reject a short commit and a tarball URL', () => {
  const base = { name: '@acme/tools', git: { url: 'https://github.com/acme/tools', versions: [] } };
  assert.throws(
    () => loadCatalog({ title: 'M', plugins: [{ ...base, git: { ...base.git, versions: [{ version: '1.0.0', commit: 'abc', publishTimestamp: 1 }] } }] }),
    (error) => error instanceof CatalogError && error.path.endsWith('.commit'),
  );
  assert.throws(
    () => loadCatalog({ title: 'M', plugins: [{ ...base, git: { ...base.git, url: 'https://github.com/acme/tools.tar.gz' } }] }),
    /not a tarball/u,
  );
});

test('packageSlug is unique per package and path-safe', () => {
  assert.equal(packageSlug('@deepseek-ai/dsh-base'), 'deepseek-ai-dsh-base');
  assert.equal(packageSlug('plain'), 'plain');
  assert.notEqual(packageSlug('@a/b'), packageSlug('@b/a'));
  assert.ok(!packageSlug('@scope/weird name!').match(/[^a-z0-9._-]/u));
});

test('monogramSvg is deterministic and self-contained', () => {
  const first = monogramSvg('@acme/tools');
  assert.equal(first, monogramSvg('@acme/tools'));
  assert.match(first, /^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
  assert.match(first, />T</u);
  assert.ok(!/https?:\/\//u.test(first.replace('http://www.w3.org/2000/svg', '')));
});

test('an empty catalog produces a valid index with no plugins', () => {
  const loaded = loadCatalog({ title: 'Empty market', plugins: [] });
  const document = buildDocument(loaded, {}, {});
  const parsed = parseMarketIndex(document, INDEX_URL);
  assert.deepEqual(parsed.plugins, []);
  assert.deepEqual(document.plugins, []);
});
