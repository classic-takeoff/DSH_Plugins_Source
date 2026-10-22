#!/usr/bin/env node
/**
 * Upload every plugin package waiting in `inbox/`, as one commit and one push.
 * Built for a Harness scheduled task: no prompts, no interactive input.
 *
 *   node scripts/upload-inbox.mjs [--inbox DIR] [--dry-run] [--no-push] [--keep] [--update]
 *
 * Drop one folder per plugin into `inbox/` (same layout as `plugins/<name>/`). After a
 * successful push, uploaded folders move to `inbox/.done/` so the next run ignores them.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyPluginTree } from '../lib/copy.mjs';
import { useGit } from '../lib/git.mjs';
import { folderFor, PluginError, readPlugin, scanPlugins } from '../lib/plugins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_ROOT = path.join(ROOT, 'plugins');
const { git, gitOrNull, run } = useGit(ROOT);

function usage() {
  console.log('Upload every plugin folder in inbox/ with one commit and one push.');
  console.log('usage: node scripts/upload-inbox.mjs [--inbox DIR] [--dry-run] [--no-push] [--keep] [--update]');
}

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

async function isDirectory(candidate) {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function readInbox(inbox) {
  let entries;
  try {
    entries = await fs.readdir(inbox, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(inbox, entry.name);
    try {
      await fs.access(path.join(dir, 'package.json'));
    } catch {
      continue;
    }
    found.push({ dir, name: entry.name });
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const inbox = path.resolve(ROOT, args.inbox ?? 'inbox');
  const pending = await readInbox(inbox);
  if (pending.length === 0) {
    console.log('inbox is empty');
    return;
  }

  const plugins = [];
  const names = new Map();
  for (const item of pending) {
    const plugin = await readPlugin(item.dir, item.name, `inbox/${item.name}`);
    if (names.has(plugin.name)) {
      throw new PluginError(`inbox/${item.name}`, `duplicates ${plugin.name}, also in inbox/${names.get(plugin.name)}`);
    }
    names.set(plugin.name, item.name);
    plugins.push({ ...plugin, folder: folderFor(plugin.name, `inbox/${item.name}`) });
  }

  const top = gitOrNull(['rev-parse', '--show-toplevel']);
  if (top === undefined || path.resolve(top) !== ROOT) {
    throw new Error(`upload must run inside the repository clone at ${ROOT}`);
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main' && branch !== 'master') {
    throw new Error(`refusing to upload from branch ${branch}; switch to main or master`);
  }
  if (gitOrNull(['remote', 'get-url', 'origin']) === undefined) {
    throw new Error('no origin remote configured');
  }

  // The inbox lives inside the repository, so its own untracked files are not "dirty".
  const relativeInbox = path.relative(ROOT, inbox).replaceAll('\\', '/');
  const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean).filter((line) => {
    const changed = line.slice(3).trim().replace(/^"|"$/gu, '').replaceAll('\\', '/').replace(/\/$/u, '');
    return changed !== relativeInbox && !changed.startsWith(`${relativeInbox}/`);
  });
  if (dirty.length > 0) {
    throw new Error(`the repository has uncommitted changes; commit them first:\n${dirty.join('\n')}`);
  }

  const existing = await scanPlugins(PLUGINS_ROOT);
  const existingNames = new Set(existing.map((plugin) => plugin.name));
  const existingFolders = new Set(existing.map((plugin) => plugin.folder));
  const conflicts = plugins.filter((plugin) => existingNames.has(plugin.name) || existingFolders.has(plugin.folder));
  if (conflicts.length > 0 && args.update !== true) {
    throw new Error(`already in plugins/: ${conflicts.map((plugin) => plugin.name).join(', ')}; pass --update to replace`);
  }

  console.log(`found ${String(plugins.length)} plugin(s) in inbox:`);
  for (const plugin of plugins) console.log(`  ${plugin.name}@${plugin.version} -> plugins/${plugin.folder}`);

  if (args['dry-run'] === true) {
    console.log('dry run: validation passed, nothing was changed');
    return;
  }

  const identityName = gitOrNull(['config', 'user.name']);
  const identityEmail = gitOrNull(['config', 'user.email']);
  if (identityName === undefined || identityEmail === undefined) {
    throw new Error('git user.name/user.email are not configured; run:\n  git config user.name "Your Name"\n  git config user.email "you@example.com"');
  }

  for (const plugin of plugins) {
    const target = path.join(PLUGINS_ROOT, plugin.folder);
    if (await isDirectory(target)) await fs.rm(target, { recursive: true, force: true });
    await copyPluginTree(plugin.dir, target);
  }
  await scanPlugins(PLUGINS_ROOT);

  const message = plugins.length === 1
    ? `feat(plugins): add ${plugins[0].name}@${plugins[0].version}`
    : `feat(plugins): add ${String(plugins.length)} plugins`;
  git(['add', '--', ...plugins.map((plugin) => `plugins/${plugin.folder}`)]);
  git(['commit', '-m', message]);
  const commit = git(['rev-parse', 'HEAD']);
  const timestamp = Number(git(['log', '-1', '--format=%ct']));
  console.log(`committed ${commit.slice(0, 7)} ${message}`);

  run(process.execPath, [path.join('scripts', 'build.mjs'), '--commit', commit, '--timestamp', String(timestamp)]);

  if (args['no-push'] !== true) {
    try {
      run('git', ['push', 'origin', `HEAD:${branch}`]);
    } catch {
      throw new Error('git push failed; log in with `git credential-manager github login` and run this task again');
    }
    console.log(`pushed to ${branch}; GitHub Actions is rebuilding the index`);
  } else {
    console.log('--no-push: commit created locally, not pushed');
  }

  if (args.keep !== true) {
    const archive = path.join(inbox, '.done');
    await fs.mkdir(archive, { recursive: true });
    for (const plugin of plugins) {
      let target = path.join(archive, plugin.folder);
      if (await isDirectory(target)) target = path.join(archive, `${plugin.folder}-${String(Date.now())}`);
      await fs.rename(plugin.dir, target);
    }
    console.log(`moved ${String(plugins.length)} folder(s) to inbox/.done`);
  }

  console.log('');
  for (const plugin of plugins) console.log(`uploaded ${plugin.name}@${plugin.version} -> plugins/${plugin.folder}`);
}

main().catch((error) => {
  console.error(`\nupload failed: ${error instanceof PluginError ? error.message : error.message}`);
  process.exitCode = 1;
});
