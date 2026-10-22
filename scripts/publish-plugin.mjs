#!/usr/bin/env node
/**
 * Publish one local plugin project into this repository.
 *
 *   node scripts/publish-plugin.mjs <local-plugin-dir> [options]
 *
 * The plugin directory is copied to `plugins/<name>/`, committed, the index is rebuilt
 * against the new commit, and the branch is pushed. GitHub Actions then rebuilds and
 * deploys the index, so the plugin becomes installable from the market.
 *
 * Options:
 *   --dry-run        validate and print the plan; change nothing
 *   --no-push        copy and commit, but do not push
 *   --no-commit      copy only, leave the changes for you to review and commit
 *   --update         replace an existing plugins/<name> folder
 *   --allow-dirty    allow unrelated uncommitted changes in this repository
 *   --message TEXT   commit message (default: feat(plugins): add <name>@<version>)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseJson, PluginError, readPlugin, scanPlugins, shortName } from '../lib/plugins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_ROOT = path.join(ROOT, 'plugins');
const EXCLUDED = new Set(['node_modules', '.git', '.cache', '.pnpm-store', 'dist', 'coverage', '.turbo', '.DS_Store']);

function usage() {
  console.log('Automated upload: copy a local plugin into plugins/, commit, rebuild the index and push.');
  console.log(`usage: node scripts/publish-plugin.mjs <local-plugin-dir> [--dry-run] [--no-push] [--no-commit] [--update] [--allow-dirty] [--message TEXT]`);
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

/**
 * Run git and capture its output through temporary files instead of pipes, so the helper
 * also works in sandboxes that forbid piped stdio.
 */
function git(args) {
  const stamp = `${String(process.pid)}-${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
  const stdoutFile = path.join(os.tmpdir(), `dsh-git-${stamp}.out`);
  const stderrFile = path.join(os.tmpdir(), `dsh-git-${stamp}.err`);
  const stdoutFd = fsSync.openSync(stdoutFile, 'w');
  const stderrFd = fsSync.openSync(stderrFile, 'w');
  let status = 0;
  try {
    execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', stdoutFd, stderrFd] });
  } catch (error) {
    status = error.status ?? 1;
  } finally {
    fsSync.closeSync(stdoutFd);
    fsSync.closeSync(stderrFd);
  }
  const stdout = fsSync.readFileSync(stdoutFile, 'utf8').trim();
  const stderr = fsSync.readFileSync(stderrFile, 'utf8').trim();
  fsSync.rmSync(stdoutFile, { force: true });
  fsSync.rmSync(stderrFile, { force: true });
  if (status !== 0) throw new Error(stderr === '' ? `git ${args.join(' ')} failed with exit code ${String(status)}` : stderr);
  return stdout;
}

function gitOrNull(args) {
  try {
    return git(args);
  } catch {
    return undefined;
  }
}

function run(command, args) {
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });
}

async function copyTree(source, target) {
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name)) continue;
    await fs.cp(path.join(source, entry.name), path.join(target, entry.name), {
      recursive: true,
      dereference: false,
      force: true,
    });
  }
}

function folderFor(name, sourceDir) {
  const short = shortName(name);
  const folder = /^[a-z0-9][a-z0-9._-]*$/u.test(short) ? short : '';
  if (folder === '') {
    throw new PluginError(sourceDir, `cannot derive a safe plugins/ folder name from ${name}; use a package name made of letters, digits, dots, dashes or underscores`);
  }
  return folder;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length !== 1) {
    usage();
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const sourceDir = path.resolve(process.cwd(), String(args._[0]));
  const sourceStat = await fs.stat(sourceDir).catch(() => undefined);
  if (sourceStat === undefined || !sourceStat.isDirectory()) {
    throw new PluginError(sourceDir, 'must be a directory that contains a plugin package');
  }
  if (sourceDir === ROOT || ROOT.startsWith(sourceDir + path.sep)) {
    throw new PluginError(sourceDir, 'must not contain the repository itself');
  }

  const folder = folderFor(await packageNameOf(sourceDir), sourceDir);
  const targetDir = path.join(PLUGINS_ROOT, folder);
  if (targetDir === sourceDir || targetDir.startsWith(sourceDir + path.sep) || sourceDir.startsWith(targetDir + path.sep)) {
    throw new PluginError(sourceDir, 'must not overlap plugins/<name>');
  }
  const exists = await fs.stat(targetDir).then((stat) => stat.isDirectory()).catch(() => false);

  if (exists && args.update !== true) {
    throw new PluginError(`plugins/${folder}`, 'already exists; pass --update to replace it');
  }

  const plugin = await readPlugin(sourceDir, folder, sourceDir);
  const config = loadConfig(parseJson(await fs.readFile(path.join(ROOT, 'index.config.json'), 'utf8'), 'index.config.json'));

  const top = gitOrNull(['rev-parse', '--show-toplevel']);
  if (top === undefined || path.resolve(top) !== ROOT) {
    throw new Error(`publish must run inside the repository clone at ${ROOT}`);
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main' && branch !== 'master') {
    console.warn(`warning: on branch ${branch}; GitHub Actions deploys only from main or master`);
  }
  if (gitOrNull(['remote', 'get-url', 'origin']) === undefined) {
    console.warn('warning: no origin remote configured; the final push will fail until one exists');
  }

  // A plugin project may live inside this repository; its own untracked or modified files are
  // expected and must not trip the "working tree is dirty" guard.
  const relativeSource = path.relative(ROOT, sourceDir).replaceAll('\\', '/');
  const insideRepo = relativeSource !== '' && !relativeSource.startsWith('..') && !path.isAbsolute(relativeSource);
  const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean).filter((line) => {
    if (!insideRepo) return true;
    const changed = line.slice(3).trim().replace(/^"|"$/gu, '').replaceAll('\\', '/').replace(/\/$/u, '');
    return changed !== relativeSource
      && !relativeSource.startsWith(`${changed}/`)
      && !changed.startsWith(`${relativeSource}/`);
  });
  if (dirty.length > 0 && args['allow-dirty'] !== true) {
    throw new Error(`the repository has uncommitted changes; commit or stash them first, or pass --allow-dirty:\n${dirty.join('\n')}`);
  }

  console.log(`publishing ${plugin.name}@${plugin.version}`);
  console.log(`  from ${sourceDir}`);
  console.log(`  to   plugins/${folder}`);
  if (exists) console.log('  mode update (existing folder will be replaced)');

  if (args['dry-run'] === true) {
    console.log('dry run: validation passed, nothing was changed');
    return;
  }

  if (exists) await fs.rm(targetDir, { recursive: true, force: true });
  await copyTree(sourceDir, targetDir);
  console.log('copied');

  await fs.access(path.join(targetDir, 'package.json'));
  const plugins = await scanPlugins(PLUGINS_ROOT);
  const published = plugins.find((entry) => entry.name === plugin.name);
  if (published === undefined || published.folder !== folder) {
    throw new PluginError(`plugins/${folder}`, 'was not picked up by the plugin scan');
  }
  console.log(`validated: ${String(plugins.length)} plugin(s) in plugins/`);

  if (args['no-commit'] === true) {
    console.log('\ncopied only. Review and commit with:');
    console.log(`  git add plugins/${folder}`);
    console.log(`  git commit -m "feat(plugins): add ${plugin.name}@${plugin.version}"`);
    console.log('  git push');
    return;
  }

  const identityName = gitOrNull(['config', 'user.name']);
  const identityEmail = gitOrNull(['config', 'user.email']);
  if (identityName === undefined || identityEmail === undefined) {
    throw new Error('git user.name/user.email are not configured; run:\n  git config user.name "Your Name"\n  git config user.email "you@example.com"');
  }

  const message = String(args.message ?? `feat(plugins): add ${plugin.name}@${plugin.version}`);
  try {
    git(['add', '--', `plugins/${folder}`]);
    git(['commit', '-m', message]);
  } catch (error) {
    console.error('git commit failed; the copied folder is still in your working tree');
    throw error;
  }
  const commit = git(['rev-parse', 'HEAD']);
  const timestamp = Number(git(['log', '-1', '--format=%ct']));
  console.log(`committed ${commit.slice(0, 7)} ${message}`);

  run(process.execPath, [path.join('scripts', 'build.mjs'), '--commit', commit, '--timestamp', String(timestamp)]);
  console.log('index built and validated against the new commit');

  if (args['no-push'] === true) {
    console.log('\n--no-push: run `git push` when you are ready');
    return;
  }
  try {
    run('git', ['push', 'origin', `HEAD:${branch}`]);
  } catch {
    throw new Error('git push failed; log in with `git credential-manager github login` and retry, or run `git push` yourself');
  }
  console.log('');
  console.log(`pushed to ${branch}. GitHub Actions is rebuilding the index now.`);
  console.log(`actions: ${config.repository}/actions`);
  console.log(`index source: ${config.indexUrl ?? 'see index.config.json'}`);
}

async function packageNameOf(dir) {
  let manifest;
  try {
    manifest = parseJson(await fs.readFile(path.join(dir, 'package.json'), 'utf8'), `${dir}/package.json`);
  } catch (error) {
    throw new PluginError(dir, `must contain a readable package.json (${error.message})`);
  }
  if (typeof manifest.name !== 'string' || manifest.name === '') throw new PluginError(`${dir}/package.json: name`, 'must be a non-empty string');
  return manifest.name;
}

main().catch((error) => {
  console.error(`\npublish failed: ${error instanceof PluginError ? error.message : error.message}`);
  process.exitCode = 1;
});
