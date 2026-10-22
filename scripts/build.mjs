#!/usr/bin/env node
/**
 * Build the plugin market index from `plugins/` and validate it.
 *
 *   node scripts/build.mjs [--plugins DIR] [--config FILE] [--out DIR]
 *                          [--commit SHA] [--timestamp UNIX_SECONDS]
 *                          [--index-url URL] [--repo-url URL]
 *
 * Every index entry is pinned to `--commit` and its `plugins/<folder>` path, so the
 * commit must contain the plugin folders. The default is HEAD; CI passes the pushed
 * commit explicitly. Validation runs in memory before dist/ is touched.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MarketIndexError, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';
import { buildDocument, iconReference, loadConfig, parseJson, scanPlugins } from '../lib/plugins.mjs';
import { monogramSvg } from '../lib/icons.mjs';

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

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (error) {
    throw new Error(`cannot read git metadata (${error.code ?? error.message}); pass --commit <40-hex-sha> and --timestamp <unix-seconds> explicitly`);
  }
}

const escapeHtml = (text) => text.replace(/[<>&"]/gu, (character) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;',
})[character]);

function renderLandingPage(document, indexUrl, repository) {
  const cards = document.plugins.map((plugin) => {
    const title = plugin.title.en;
    const description = plugin.description?.en ?? '';
    const version = plugin.versions[0]?.version ?? '';
    const tag = plugin.metadata.category === undefined ? '' : `<span class="tag">${escapeHtml(plugin.metadata.category)}</span>`;
    return `<li class="card">
      <img src="${escapeHtml(plugin.icon)}" alt="" width="48" height="48" loading="lazy">
      <div class="body">
        <p class="name">${escapeHtml(title)} ${tag}</p>
        <p class="pkg">${escapeHtml(plugin.name)}</p>
        <p class="desc">${escapeHtml(description)}</p>
      </div>
      <p class="meta">${escapeHtml(version)}</p>
    </li>`;
  }).join('\n');
  const list = document.plugins.length === 0
    ? `<p class="empty">No plugins yet. Add a package under <code>plugins/</code> (or run <code>node scripts/publish-plugin.mjs &lt;path&gt;</code>), push, and the index rebuilds here.</p>`
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
  <p>Human-readable preview. Machine-readable index: <a href="index.json">index.json</a> · source: <a href="${escapeHtml(repository)}">${escapeHtml(repository.replace(/^https:\/\/github\.com\//u, ''))}</a></p>
  <p>In DeepSeek Harness: <code>Plugins → Discover → Add index source</code>, then paste <code>${escapeHtml(indexUrl)}</code>.</p>
</footer>
</body>
</html>
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/build.mjs [--plugins DIR] [--config FILE] [--out DIR] [--commit SHA] [--timestamp SECONDS] [--index-url URL] [--repo-url URL]');
    return;
  }

  const pluginsRoot = path.resolve(ROOT, args.plugins ?? 'plugins');
  const configPath = path.resolve(ROOT, args.config ?? 'index.config.json');
  const outDir = path.resolve(ROOT, args.out ?? 'dist');
  if (outDir === ROOT || !outDir.startsWith(ROOT + path.sep)) throw new Error(`refusing to write outside the project: ${outDir}`);

  const config = loadConfig(parseJson(await fs.readFile(configPath, 'utf8'), 'index.config.json'));
  const repository = args['repo-url'] ?? config.repository;
  const indexUrl = String(args['index-url'] ?? config.indexUrl ?? DEFAULT_INDEX_URL);
  if (!URL.canParse(indexUrl)) throw new Error(`--index-url must be an absolute URL, got ${indexUrl}`);

  const commit = String(args.commit ?? git(['rev-parse', 'HEAD']));
  const publishTimestamp = Number(args.timestamp ?? git(['log', '-1', '--format=%ct']));
  const plugins = await scanPlugins(pluginsRoot);
  console.log(`plugins: ${String(plugins.length)} from ${path.relative(ROOT, pluginsRoot) || '.'}; commit ${commit.slice(0, 7)}`);

  const document = buildDocument({
    config: { ...config, repository },
    plugins,
    commit,
    publishTimestamp,
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

  const iconFiles = new Map();
  for (const plugin of plugins) {
    const reference = iconReference(plugin);
    const name = reference.slice('icons/'.length);
    if (plugin.meta.icon?.kind === 'file') {
      iconFiles.set(name, await fs.readFile(plugin.meta.icon.path));
    } else if (plugin.meta.icon === undefined) {
      iconFiles.set(name, Buffer.from(monogramSvg(plugin.name), 'utf8'));
    }
  }

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(path.join(outDir, 'icons'), { recursive: true });
  for (const [name, body] of iconFiles) await fs.writeFile(path.join(outDir, 'icons', name), body);
  await fs.writeFile(path.join(outDir, 'index.json'), `${JSON.stringify(document, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, 'index.html'), renderLandingPage(document, indexUrl, repository));
  await fs.writeFile(path.join(outDir, '.nojekyll'), '');

  console.log('');
  for (const plugin of plugins) {
    console.log(`  ${plugin.folder.padEnd(24)} ${plugin.version.padEnd(12)} ${plugin.name}`);
  }
  console.log('');
  console.log(`wrote ${path.relative(ROOT, outDir)}\\index.json (${String(plugins.length)} plugins)`);
  if (plugins.length === 0) console.log('plugins/ is empty: add a folder or run node scripts/publish-plugin.mjs <path>');
  console.log(`validated against ${indexUrl}`);
}

try {
  await main();
} catch (error) {
  console.error(`\nbuild failed: ${error.message}`);
  process.exitCode = 1;
}
