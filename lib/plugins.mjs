/**
 * Plugin folders -> plugin market index format 1.
 *
 * Layout: every direct child directory of `plugins/` is one installable DSH bundle package.
 * The index entry for a plugin pins the repository at one commit and the `plugins/<folder>`
 * path, so DSH installs it with pnpm's `git+https://…#<commit>&path:/plugins/<folder>` spec.
 * Nothing here talks to npm: the repository is the only source of truth.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u;
const MAX_PACKAGE_NAME_LENGTH = 214;
const CONFIG_KEYS = new Set(['title', 'description', 'repository', 'indexUrl', 'metadata']);
const INDEX_META_KEYS = new Set(['title', 'description', 'category', 'labels', 'keywords', 'sortKeys', 'icon', 'author', 'homepage']);
const ICON_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp']);
const UNSUPPORTED_PROTOCOLS = ['workspace:', 'file:', 'link:', 'portal:'];

/** A plugin folder or index configuration that cannot be published as-is. */
export class PluginError extends Error {
  /**
   * @param {string} path json-ish path of the offending value, such as `plugins/hello/package.json`.
   * @param {string} reason the violated rule.
   */
  constructor(path, reason) {
    super(`${path}: ${reason}`);
    this.name = 'PluginError';
    this.path = path;
    this.reason = reason;
  }
}

function fail(at, reason) {
  throw new PluginError(at, reason);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectAt(value, at) {
  if (!isObject(value)) fail(at, 'must be an object');
  return value;
}

function stringAt(value, at) {
  if (typeof value !== 'string' || value.trim() === '') fail(at, 'must be a non-empty string');
  return value;
}

function optional(object, key, at, read) {
  return Object.hasOwn(object, key) ? read(object[key], `${at}.${key}`) : undefined;
}

/** Parse JSON, tolerating the UTF-8 BOM that Windows editors and PowerShell add. */
export function parseJson(text, at) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/u, ''));
  } catch (error) {
    fail(at, `must be readable JSON (${error.message})`);
  }
}

/** Localized text: a string (English) or an object keyed by lowercase language ids containing `en`. */
export function localizedText(value, at) {
  if (typeof value === 'string') return { en: stringAt(value, at) };
  const object = objectAt(value, at);
  const text = {};
  for (const [language, member] of Object.entries(object)) {
    if (!LANGUAGE_ID.test(language)) fail(`${at}.${language}`, 'must be keyed by a lowercase language id such as "zh-cn"');
    Object.defineProperty(text, language, {
      value: stringAt(member, `${at}.${language}`),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (!Object.hasOwn(text, 'en')) fail(at, 'must contain en');
  return text;
}

/** Folder-safe file name stem for one package name. */
export function packageSlug(name) {
  return name
    .replace(/^@/u, '')
    .replace(/[\\/]/gu, '-')
    .replace(/[^a-z0-9._-]+/giu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')
    .toLowerCase();
}

/** Package name without its scope, used for fallback titles and folder names. */
export function shortName(name) {
  return name.slice(name.lastIndexOf('/') + 1);
}

async function isFile(candidate) {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function httpsUrlAt(value, at) {
  const text = stringAt(value, at);
  let url;
  try {
    url = new URL(text);
  } catch {
    fail(at, 'must be an absolute URL');
  }
  if (url.protocol !== 'https:') fail(at, 'must use https:');
  if (url.username !== '' || url.password !== '') fail(at, 'must not contain credentials');
  if (url.search !== '' || url.hash !== '') fail(at, 'must not contain a query or fragment');
  if (url.href !== text) fail(at, 'must be a canonical URL without a trailing slash');
  return url;
}

/** Validate `index.config.json`: the index identity plus the repository DSH installs from. */
export function loadConfig(value) {
  const at = 'index.config.json';
  objectAt(value, at);
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) fail(`${at}.${key}`, 'is not a supported field (expected title, description, repository, indexUrl, metadata)');
  }
  const title = localizedText(value.title, `${at}.title`);
  const description = optional(value, 'description', at, localizedText);
  const repository = httpsUrlAt(value.repository, `${at}.repository`);
  if (!/^(?:\/[^/]+){2,}$/u.test(repository.pathname)) fail(`${at}.repository`, 'must name a repository with at least two path segments');
  if (/\.(?:tgz|tar\.gz)$/iu.test(repository.pathname)) fail(`${at}.repository`, 'must name a repository, not a tarball');
  const indexUrl = optional(value, 'indexUrl', at, (member, memberAt) => {
    if (typeof member !== 'string' || !URL.canParse(member)) fail(memberAt, 'must be an absolute URL');
    return member;
  });
  const metadata = optional(value, 'metadata', at, (member, memberAt) => objectAt(member, memberAt)) ?? {};
  return { title, description, repository: value.repository, indexUrl, metadata };
}

async function readIndexMeta(dir, at) {
  const file = path.join(dir, 'dsh-index.json');
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const raw = parseJson(text, `${at}/dsh-index.json`);
  objectAt(raw, `${at}/dsh-index.json`);
  for (const key of Object.keys(raw)) {
    if (!INDEX_META_KEYS.has(key)) fail(`${at}/dsh-index.json: ${key}`, 'is not a supported field (expected title, description, category, labels, keywords, sortKeys, icon, author, homepage)');
  }
  const meta = {};
  const title = optional(raw, 'title', `${at}/dsh-index.json`, localizedText);
  if (title !== undefined) meta.title = title;
  const description = optional(raw, 'description', `${at}/dsh-index.json`, localizedText);
  if (description !== undefined) meta.description = description;
  const category = optional(raw, 'category', `${at}/dsh-index.json`, stringAt);
  if (category !== undefined) meta.category = category;
  const labels = optional(raw, 'labels', `${at}/dsh-index.json`, (member, memberAt) => {
    if (!Array.isArray(member)) fail(memberAt, 'must be an array');
    return member.map((label, index) => stringAt(label, `${memberAt}[${String(index)}]`));
  });
  if (labels !== undefined) meta.labels = labels;
  const keywords = optional(raw, 'keywords', `${at}/dsh-index.json`, (member, memberAt) => {
    if (!Array.isArray(member)) fail(memberAt, 'must be an array');
    return member.map((keyword, index) => stringAt(keyword, `${memberAt}[${String(index)}]`));
  });
  if (keywords !== undefined) meta.keywords = keywords;
  const sortKeys = optional(raw, 'sortKeys', `${at}/dsh-index.json`, (member, memberAt) => {
    const values = {};
    for (const [id, sortValue] of Object.entries(objectAt(member, memberAt))) {
      if (typeof sortValue !== 'number' || !Number.isFinite(sortValue)) fail(`${memberAt}.${id}`, 'must be a finite number');
      Object.defineProperty(values, id, { value: sortValue, enumerable: true, writable: true, configurable: true });
    }
    return values;
  });
  if (sortKeys !== undefined) meta.sortKeys = sortKeys;
  const author = optional(raw, 'author', `${at}/dsh-index.json`, stringAt);
  if (author !== undefined) meta.author = author;
  const homepage = optional(raw, 'homepage', `${at}/dsh-index.json`, stringAt);
  if (homepage !== undefined) meta.homepage = homepage;
  const icon = optional(raw, 'icon', `${at}/dsh-index.json`, stringAt);
  if (icon !== undefined) meta.icon = await resolveIcon(dir, `${at}/dsh-index.json.icon`, icon);
  return meta;
}

async function resolveIcon(dir, at, value) {
  if (value.startsWith('data:')) return { kind: 'remote', value };
  if (/^https?:\/\//u.test(value)) return { kind: 'remote', value };
  if (path.isAbsolute(value) || value.split(/[\\/]/u).some((segment) => segment === '..')) fail(at, 'must be a relative file inside the plugin folder');
  const file = path.resolve(dir, value);
  if (file !== dir && !file.startsWith(dir + path.sep)) fail(at, 'must stay inside the plugin folder');
  const extension = path.extname(file).toLowerCase();
  if (!ICON_EXTENSIONS.has(extension)) fail(at, 'must be .svg, .png, .jpg, .jpeg, or .webp');
  if (!(await isFile(file))) fail(at, `does not exist: ${value}`);
  return { kind: 'file', path: file, extension };
}

/**
 * Read and check one plugin folder.
 * @param dir absolute folder path.
 * @param folder folder name under `plugins/`, used in error paths and index source paths.
 * @param at optional error prefix, for a folder outside this repository.
 * @returns the manifest plus the display metadata and icon descriptor.
 */
export async function readPlugin(dir, folder, at = `plugins/${folder}`) {
  let manifest;
  try {
    manifest = parseJson(await fs.readFile(path.join(dir, 'package.json'), 'utf8'), `${at}/package.json`);
  } catch (error) {
    fail(`${at}/package.json`, `must be readable JSON (${error.message})`);
  }
  objectAt(manifest, `${at}/package.json`);

  const name = manifest.name;
  if (typeof name !== 'string' || name.length > MAX_PACKAGE_NAME_LENGTH || !PACKAGE_NAME.test(name)) {
    fail(`${at}/package.json: name`, 'must be a valid npm package name');
  }
  if (semver.valid(manifest.version) !== manifest.version) {
    fail(`${at}/package.json: version`, 'must be an exact SemVer version such as 1.0.0');
  }
  const bundle = manifest.dsh?.bundle;
  if (!isObject(bundle) || typeof bundle.patch !== 'string' || bundle.patch.trim() === '') {
    fail(`${at}/package.json: dsh.bundle.patch`, 'must name the bundle patch file, so the package can be installed as a DSH bundle');
  }
  if (!(await isFile(path.join(dir, bundle.patch)))) {
    fail(`${at}/${bundle.patch}`, 'does not exist');
  }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      if (typeof range === 'string' && UNSUPPORTED_PROTOCOLS.some((protocol) => range.startsWith(protocol))) {
        fail(`${at}/package.json: ${field}.${dependency}`, `uses ${range.split(':')[0]}:, which pnpm cannot resolve from a git install; use a published version range`);
      }
    }
  }
  const engines = manifest.engines?.dsh;
  if (engines !== undefined) {
    if (typeof engines !== 'string' || semver.validRange(engines) === null) fail(`${at}/package.json: engines.dsh`, 'must be a SemVer range');
    if (engines.startsWith('workspace:')) fail(`${at}/package.json: engines.dsh`, 'must not be a workspace: range');
  }

  const meta = await readIndexMeta(dir, at);
  return { folder, dir, name, version: manifest.version, manifest, meta };
}

/** Read every plugin folder; empty folder list is valid. */
export async function scanPlugins(pluginsRoot) {
  let entries;
  try {
    entries = await fs.readdir(pluginsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const plugins = [];
  const foldersByName = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(pluginsRoot, entry.name);
    if (!(await isFile(path.join(dir, 'package.json')))) continue;
    const plugin = await readPlugin(dir, entry.name);
    if (foldersByName.has(plugin.name)) {
      fail(`plugins/${entry.name}/package.json: name`, `duplicates ${plugin.name}, already declared in plugins/${foldersByName.get(plugin.name)}`);
    }
    foldersByName.set(plugin.name, entry.name);
    plugins.push(plugin);
  }
  return plugins.sort((left, right) => left.name.localeCompare(right.name));
}

/** The icon reference written into the index; the asset itself is written by the builder. */
export function iconReference(plugin) {
  const { icon } = plugin.meta;
  if (icon?.kind === 'remote') return icon.value;
  const extension = icon?.kind === 'file' ? icon.extension : '.svg';
  return `icons/${packageSlug(plugin.name)}${extension}`;
}

function fallbackDescription(plugin) {
  const description = plugin.manifest.description;
  return typeof description === 'string' && description.trim() !== '' ? { en: description } : undefined;
}

function fallbackAuthor(plugin) {
  const author = plugin.manifest.author;
  if (typeof author === 'string' && author.trim() !== '') return author;
  if (isObject(author) && typeof author.name === 'string' && author.name.trim() !== '') return author.name;
  return undefined;
}

function fallbackHomepage(plugin) {
  const homepage = plugin.manifest.homepage;
  if (typeof homepage !== 'string' || !URL.canParse(homepage)) return undefined;
  const url = new URL(homepage);
  return url.protocol === 'https:' || url.protocol === 'http:' ? homepage : undefined;
}

function fallbackKeywords(plugin) {
  const keywords = plugin.manifest.keywords;
  if (!Array.isArray(keywords)) return undefined;
  const kept = keywords.filter((keyword) => typeof keyword === 'string' && keyword.trim() !== '');
  return kept.length === 0 ? undefined : kept;
}

/**
 * Build the format-1 document.
 * @param config result of {@link loadConfig}.
 * @param plugins result of {@link scanPlugins}.
 * @param commit 40-hex commit that contains the plugin folders.
 * @param publishTimestamp Unix seconds recorded for every listed version.
 */
export function buildDocument({ config, plugins, commit, publishTimestamp }) {
  if (!/^[0-9a-f]{40}$/u.test(commit)) fail('--commit', 'must be a lowercase 40-hex-digit commit SHA');
  if (!Number.isInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= 1e11) fail('--timestamp', 'must be an integer number of Unix seconds in [0, 10^11)');

  const entries = plugins.map((plugin) => {
    const { meta, manifest } = plugin;
    const title = meta.title ?? { en: shortName(plugin.name) };
    const description = meta.description ?? fallbackDescription(plugin);
    const author = meta.author ?? fallbackAuthor(plugin);
    const homepage = meta.homepage ?? fallbackHomepage(plugin);
    const keywords = meta.keywords ?? fallbackKeywords(plugin) ?? [];
    return {
      name: plugin.name,
      title,
      ...(description === undefined ? {} : { description }),
      icon: iconReference(plugin),
      ...(author === undefined ? {} : { author }),
      ...(homepage === undefined ? {} : { homepage }),
      metadata: {
        ...(meta.category === undefined ? {} : { category: meta.category }),
        keywords,
        labels: meta.labels ?? [],
        sortKeys: meta.sortKeys ?? {},
      },
      versions: [
        {
          version: plugin.version,
          publishTimestamp,
          ...(manifest.engines?.dsh === undefined ? {} : { engines: { dsh: manifest.engines.dsh } }),
          source: { type: 'git', url: config.repository, commit, path: `plugins/${plugin.folder}` },
        },
      ],
    };
  });

  return {
    format: 1,
    title: config.title,
    ...(config.description === undefined ? {} : { description: config.description }),
    metadata: config.metadata,
    plugins: entries,
  };
}
