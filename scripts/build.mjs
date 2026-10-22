#!/usr/bin/env node
/**
 * Build the format-1 index from the catalog and the npm registry.
 *
 *   node scripts/build.mjs [--sources sources/index.json] [--out dist]
 *                          [--registry https://registry.npmjs.org]
 *                          [--index-url http://127.0.0.1:8787/index.json]
 *                          [--refresh] [--offline]
 *
 * Validation happens in memory, before anything is written: a bad catalog never reaches dist/.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMarketIndex, MarketIndexError } from '@deepseek-ai/dsh-plugin-market-index';
import { buildDocument, loadCatalog, packageSlug, shortName } from '../lib/catalog.mjs';
import { monogramSvg, imageContentType } from '../lib/icons.mjs';
import { DEFAULT_REGISTRY, mapConcurrent, normalizeRegistry, readPackageDocument } from '../lib/registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INDEX_URL = 'http://127.0.0.1:8787/index.json';

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
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

const escapeHtml = (text) => text.replace(/[<>&"]/gu, (character) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;',
})[character]);

function renderLandingPage(document, indexUrl) {
  const cards = document.plugins.map((plugin) => {
    const title = plugin.title.en;
    const description = plugin.description?.en ?? '';
    const latest = plugin.versions[0]?.version ?? '';
    const tag = plugin.metadata.category === undefined ? '' : `<span class="tag">${escapeHtml(plugin.metadata.category)}</span>`;
    return `<li class="card">
      <img src="${escapeHtml(plugin.icon)}" alt="" width="48" height="48" loading="lazy">
      <div class="body">
        <p class="name">${escapeHtml(title)} ${tag}</p>
        <p class="pkg">${escapeHtml(plugin.name)}</p>
        <p class="desc">${escapeHtml(description)}</p>
      </div>
      <p class="meta">${escapeHtml(latest)}<br><span>${String(plugin.versions.length)} version${plugin.versions.length === 1 ? '' : 's'}</span></p>
    </li>`;
  }).join('\n');
  const list = document.plugins.length === 0
    ? `<p class="empty">No plugins yet. Add entries to <code>sources/index.json</code>, run <code>node scripts/build.mjs</code>, and push.</p>`
    : `<ul>\n${cards}\n</ul>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(document.title.en)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0 auto; max-width: 56rem; padding: 2rem 1rem; font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  .sub { margin: 0 0 1.5rem; opacity: .7; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .75rem; }
  .card { display: flex; gap: .9rem; align-items: flex-start; padding: .9rem; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 12px; }
  .body { flex: 1; min-width: 0; }
  .name { margin: 0; font-weight: 600; }
  .tag { font-size: .72rem; font-weight: 500; padding: .1rem .4rem; border-radius: 999px; background: color-mix(in srgb, currentColor 12%, transparent); vertical-align: middle; }
  .pkg, .meta { margin: .1rem 0 0; font-size: .8rem; opacity: .65; font-family: ui-monospace, SFMono-Regular, monospace; }
  .desc { margin: .3rem 0 0; }
  .meta { text-align: right; white-space: nowrap; }
  .empty { padding: 1.5rem; border: 1px dashed color-mix(in srgb, currentColor 30%, transparent); border-radius: 12px; opacity: .8; }
  code { font-family: ui-monospace, SFMono-Regular, monospace; }
  footer { margin-top: 2rem; font-size: .85rem; opacity: .7; }
</style>
</head>
<body>
<h1>${escapeHtml(document.title.en)}</h1>
<p class="sub">${escapeHtml(document.description?.en ?? 'A DeepSeek Harness plugin index.')}</p>
${list}
<footer>
  <p>This page is a human-readable preview. The machine-readable index is <a href="index.json">index.json</a>.</p>
  <p>In DeepSeek Harness: <code>Plugins → Discover → Add index source</code>, then paste <code>${escapeHtml(indexUrl)}</code>.</p>
</footer>
</body>
</html>
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/build.mjs [--sources FILE] [--out DIR] [--registry URL] [--index-url URL] [--refresh] [--offline]');
    return;
  }

  const sourcesPath = path.resolve(ROOT, args.sources ?? 'sources/index.json');
  const outDir = path.resolve(ROOT, args.out ?? 'dist');
  if (outDir === ROOT || !outDir.startsWith(ROOT + path.sep)) {
    throw new Error(`refusing to write outside the project: ${outDir}`);
  }
  const cacheDir = path.join(ROOT, '.cache', 'registry');
  const registry = normalizeRegistry(args.registry ?? DEFAULT_REGISTRY);

  const raw = JSON.parse(await fs.readFile(sourcesPath, 'utf8'));
  const catalog = loadCatalog(raw);
  const indexUrl = String(args['index-url'] ?? raw.indexUrl ?? DEFAULT_INDEX_URL);
  if (!URL.canParse(indexUrl)) throw new Error(`--index-url must be an absolute URL, got ${indexUrl}`);

  console.log(`catalog: ${String(catalog.plugins.length)} plugins from ${path.relative(ROOT, sourcesPath)}`);
  const npmPlugins = catalog.plugins.filter((plugin) => plugin.git === undefined);
  const documents = {};
  await mapConcurrent(npmPlugins, 6, async (plugin) => {
    const document = await readPackageDocument(plugin.name, {
      registry: plugin.registry ?? registry,
      cacheDir,
      refresh: args.refresh === true,
      offline: args.offline === true,
    });
    documents[plugin.name] = document;
    process.stdout.write(`  fetched ${plugin.name}\n`);
  });

  // Resolve icons: pass-through references, copied local files, or a generated monogram.
  const iconFiles = new Map();
  const icons = {};
  for (const plugin of catalog.plugins) {
    const slug = packageSlug(plugin.name);
    if (plugin.icon !== undefined && (plugin.icon.startsWith('data:') || /^https?:/u.test(plugin.icon))) {
      icons[plugin.name] = plugin.icon;
      continue;
    }
    if (plugin.icon !== undefined) {
      const source = path.resolve(ROOT, plugin.icon);
      if (!source.startsWith(ROOT + path.sep)) throw new Error(`icon must stay inside the project: ${plugin.icon}`);
      const type = imageContentType(source);
      if (type === undefined) throw new Error(`icon must be .svg, .png, .jpg, .jpeg, or .webp: ${plugin.icon}`);
      const extension = path.extname(source).toLowerCase();
      const name = `icons/${slug}${extension}`;
      iconFiles.set(name, await fs.readFile(source));
      icons[plugin.name] = name;
      continue;
    }
    const name = `icons/${slug}.svg`;
    iconFiles.set(name, Buffer.from(monogramSvg(plugin.name), 'utf8'));
    icons[plugin.name] = name;
  }

  const document = buildDocument(catalog, documents, icons, {
    onSkipped: (name, version) => console.log(`  skip ${name}@${version} (not a bundle)`),
  });

  try {
    parseMarketIndex(document, indexUrl);
  } catch (error) {
    if (error instanceof MarketIndexError) {
      console.error(`\nindex is not valid format 1: ${error.path} ${error.reason}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(path.join(outDir, 'icons'), { recursive: true });
  for (const [name, body] of iconFiles) await fs.writeFile(path.join(outDir, name), body);
  await fs.writeFile(path.join(outDir, 'index.json'), `${JSON.stringify(document, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, 'index.html'), renderLandingPage(document, indexUrl));
  await fs.writeFile(path.join(outDir, '.nojekyll'), '');

  const bytes = Buffer.byteLength(JSON.stringify(document));
  console.log('');
  for (const plugin of document.plugins) {
    const latest = plugin.versions[0]?.version ?? '-';
    console.log(`  ${shortName(plugin.name).padEnd(34)} ${latest.padEnd(16)} ${String(plugin.versions.length).padStart(2)} version(s)`);
  }
  console.log('');
  console.log(`wrote ${path.relative(ROOT, outDir)}\\index.json (${String(document.plugins.length)} plugins, ${(bytes / 1024).toFixed(1)} KiB)`);
  if (document.plugins.length === 0) {
    console.log('the catalog is empty: add entries under sources/index.json, then rebuild');
  }
  console.log(`validated against ${indexUrl}`);
  console.log(`next: node scripts/serve.mjs   (serves ${indexUrl})`);
}

try {
  await main();
} catch (error) {
  console.error(`\nbuild failed: ${error.message}`);
  process.exitCode = 1;
}
