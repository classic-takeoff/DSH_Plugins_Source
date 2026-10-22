/**
 * Pure catalog logic: turn a hand-written catalog plus npm registry documents into a
 * format-1 plugin market index. No I/O here, so every rule is testable.
 */
import semver from 'semver';

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/u;
const MAX_PACKAGE_NAME_LENGTH = 214;

/** A catalog or registry document broke a rule the index format cannot express. */
export class CatalogError extends Error {
  /**
   * @param {string} path JSON path of the offending value.
   * @param {string} reason the violated rule.
   */
  constructor(path, reason) {
    super(`${path} ${reason}`);
    this.name = 'CatalogError';
    this.path = path;
    this.reason = reason;
  }
}

function fail(path, reason) {
  throw new CatalogError(path, reason);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectAt(value, path) {
  if (!isObject(value)) fail(path, 'must be an object');
  return value;
}

function stringAt(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a non-empty string');
  return value;
}

function optional(object, key, path, read) {
  return Object.hasOwn(object, key) ? read(object[key], `${path}.${key}`) : undefined;
}

/**
 * Localized text: either a string (English) or an object keyed by lowercase language ids that
 * must contain `en`, matching what the index format accepts.
 */
export function localizedText(value, path) {
  if (typeof value === 'string') {
    return { en: stringAt(value, path) };
  }
  const object = objectAt(value, path);
  const text = {};
  for (const [language, member] of Object.entries(object)) {
    if (!LANGUAGE_ID.test(language)) fail(`${path}.${language}`, 'must be keyed by a lowercase language id');
    // defineProperty keeps an id such as `__proto__` an ordinary key
    Object.defineProperty(text, language, {
      value: stringAt(member, `${path}.${language}`),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (!Object.hasOwn(text, 'en')) fail(path, 'must contain en');
  return text;
}

/** The file name stem for one package, unique for distinct npm names. */
export function packageSlug(name) {
  return name
    .replace(/^@/u, '')
    .replace(/[\\/]/gu, '-')
    .replace(/[^a-z0-9._-]+/giu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')
    .toLowerCase();
}

function httpUrlAt(value, path) {
  const text = stringAt(value, path);
  let url;
  try {
    url = new URL(text);
  } catch {
    fail(path, 'must be an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(path, 'must use https: or http:');
  if (url.username !== '' || url.password !== '') fail(path, 'must not contain credentials');
  if (url.search !== '' || url.hash !== '') fail(path, 'must not contain a query or fragment');
  return url.href;
}

function packagePathAt(value, path) {
  const text = stringAt(value, path);
  if (text.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment))) {
    fail(path, 'must be a relative directory of letters, digits, and ._@+- segments without . or ..');
  }
  return text;
}

function gitVersionsAt(git, path) {
  const url = httpUrlAt(git.url, `${path}.url`);
  if (url !== git.url) fail(`${path}.url`, 'must be a canonical URL');
  if (!/^(?:\/[^/]+){2,}$/u.test(new URL(url).pathname)) fail(`${path}.url`, 'must name a repository with at least two path segments');
  if (/\.(?:tgz|tar\.gz)$/iu.test(new URL(url).pathname)) fail(`${path}.url`, 'must name a repository, not a tarball');
  const directory = optional(git, 'path', path, packagePathAt);
  const entries = git.versions;
  if (!Array.isArray(entries) || entries.length === 0) fail(`${path}.versions`, 'must be a non-empty array');
  const seen = new Set();
  return entries.map((entry, index) => {
    const at = `${path}.versions[${String(index)}]`;
    objectAt(entry, at);
    const version = stringAt(entry.version, `${at}.version`);
    if (semver.valid(version) !== version) fail(`${at}.version`, 'must be an exact SemVer version');
    if (seen.has(version)) fail(`${at}.version`, `duplicates ${version}`);
    seen.add(version);
    const commit = stringAt(entry.commit, `${at}.commit`);
    if (!COMMIT.test(commit)) fail(`${at}.commit`, 'must be a lowercase 40-hex-digit commit SHA');
    const publishTimestamp = entry.publishTimestamp;
    if (!Number.isInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= 1e11) {
      fail(`${at}.publishTimestamp`, 'must be an integer number of Unix seconds in [0, 10^11)');
    }
    return {
      version,
      publishTimestamp,
      source: { type: 'git', url, commit, ...(directory === undefined ? {} : { path: directory }) },
    };
  });
}

/** Read and check the catalog document's own shape. */
export function loadCatalog(value) {
  const object = objectAt(value, '$');
  const title = localizedText(object.title, '$.title');
  const description = optional(object, 'description', '$', localizedText);
  const metadata = object.metadata === undefined ? {} : objectAt(object.metadata, '$.metadata');
  if (!Array.isArray(object.plugins)) fail('$.plugins', 'must be an array');

  const names = new Set();
  const plugins = object.plugins.map((entry, index) => {
    const path = `$.plugins[${String(index)}]`;
    objectAt(entry, path);
    const name = stringAt(entry.name, `${path}.name`);
    if (name.length > MAX_PACKAGE_NAME_LENGTH || !PACKAGE_NAME.test(name)) fail(`${path}.name`, 'must be a valid npm package name');
    if (names.has(name)) fail(`${path}.name`, `duplicates ${name}`);
    names.add(name);

    const plugin = {
      name,
      title: optional(entry, 'title', path, localizedText),
      description: optional(entry, 'description', path, localizedText),
      category: optional(entry, 'category', path, (member, at) => stringAt(member, at)),
      labels: optional(entry, 'labels', path, (member, at) => {
        if (!Array.isArray(member)) fail(at, 'must be an array');
        return member.map((label, position) => stringAt(label, `${at}[${String(position)}]`));
      }),
      keywords: optional(entry, 'keywords', path, (member, at) => {
        if (!Array.isArray(member)) fail(at, 'must be an array');
        return member.map((keyword, position) => stringAt(keyword, `${at}[${String(position)}]`));
      }),
      sortKeys: optional(entry, 'sortKeys', path, (member, at) => {
        const values = {};
        for (const [id, sortValue] of Object.entries(objectAt(member, at))) {
          if (typeof sortValue !== 'number' || !Number.isFinite(sortValue)) fail(`${at}.${id}`, 'must be a finite number');
          Object.defineProperty(values, id, { value: sortValue, enumerable: true, writable: true, configurable: true });
        }
        return values;
      }),
      icon: optional(entry, 'icon', path, (member, at) => stringAt(member, at)),
      author: optional(entry, 'author', path, (member, at) => stringAt(member, at)),
      homepage: optional(entry, 'homepage', path, (member, at) => stringAt(member, at)),
      repository: optional(entry, 'repository', path, (member, at) => {
        objectAt(member, at);
        const url = stringAt(member.url, `${at}.url`);
        const directory = optional(member, 'directory', at, packagePathAt);
        return { url, ...(directory === undefined ? {} : { directory }) };
      }),
      versions: optional(entry, 'versions', path, (member, at) => {
        if (member === 'all' || member === 'latest') return member;
        if (!Array.isArray(member) || member.length === 0) fail(at, 'must be "all", "latest", or a non-empty array of versions');
        return member.map((version, position) => {
          if (semver.valid(version) !== version) fail(`${at}[${String(position)}]`, 'must be an exact SemVer version');
          return version;
        });
      }) ?? 'all',
      maxVersions: optional(entry, 'maxVersions', path, (member, at) => {
        if (!Number.isInteger(member) || member < 1) fail(at, 'must be a positive integer');
        return member;
      }),
      registry: optional(entry, 'registry', path, httpUrlAt),
      requiresBundle: entry.requiresBundle !== false,
      git: optional(entry, 'git', path, (member, at) => {
        objectAt(member, at);
        return gitVersionsAt(member, at);
      }),
    };
    if (plugin.git !== undefined && plugin.registry !== undefined) fail(path, 'must not combine git and registry');
    if (plugin.git !== undefined && plugin.versions !== 'all') fail(`${path}.versions`, 'is ignored for a git plugin; list versions under git.versions');
    return plugin;
  });

  return {
    title,
    ...(description === undefined ? {} : { description }),
    metadata,
    plugins,
  };
}

/** Short package name used as the fallback title, e.g. `schedule-bundle` for `@acme/schedule-bundle`. */
export function shortName(name) {
  return name.slice(name.lastIndexOf('/') + 1).replace(/^dsh-/u, '');
}

/** Resolve the catalog's version policy against one registry document. */
export function selectVersions(document, plugin) {
  const available = Object.keys(document.versions ?? {});
  if (available.length === 0) fail('$', `package ${plugin.name} publishes no versions`);
  let versions;
  if (plugin.versions === 'all') {
    versions = available;
  } else if (plugin.versions === 'latest') {
    const latest = document['dist-tags']?.latest;
    if (typeof latest !== 'string' || !Object.hasOwn(document.versions, latest)) {
      fail('$.plugins', `${plugin.name} has no latest dist-tag`);
    }
    versions = [latest];
  } else {
    for (const version of plugin.versions) {
      if (!Object.hasOwn(document.versions, version)) fail('$.plugins', `${plugin.name} does not publish ${version}`);
    }
    versions = plugin.versions;
  }
  versions = [...versions].sort((left, right) => semver.rcompare(left, right));
  return plugin.maxVersions === undefined ? versions : versions.slice(0, plugin.maxVersions);
}

function enginesOf(manifest) {
  const range = manifest?.engines?.dsh;
  if (typeof range !== 'string' || range.trim() === '') return undefined;
  if (range.startsWith('workspace:')) fail('$.plugins', 'engines.dsh must not be a workspace: range');
  if (semver.validRange(range) === null) fail('$.plugins', `engines.dsh ${JSON.stringify(range)} is not a SemVer range`);
  return { dsh: range };
}

/**
 * One npm version entry, with the timestamp the registry recorded for that exact version.
 * @returns the entry, or undefined when the version is not a bundle and `requiresBundle` is set.
 */
export function npmVersionEntry(document, version, plugin) {
  const manifest = document.versions?.[version];
  if (!manifest) fail('$.plugins', `${plugin.name}@${version} is missing from its registry document`);
  if (plugin.requiresBundle && !isObject(manifest.dsh?.bundle)) return undefined;
  const published = document.time?.[version];
  if (typeof published !== 'string') fail('$.plugins', `${plugin.name}@${version} has no registry publish time`);
  const publishTimestamp = Math.floor(Date.parse(published) / 1000);
  if (!Number.isInteger(publishTimestamp) || publishTimestamp < 0) fail('$.plugins', `${plugin.name}@${version} has an unparsable publish time`);
  const engines = enginesOf(manifest);
  return {
    version,
    publishTimestamp,
    ...(engines === undefined ? {} : { engines }),
    source: { type: 'npm', ...(plugin.registry === undefined ? {} : { registry: plugin.registry }) },
  };
}

function repositoryFromManifest(manifest) {
  const declared = manifest?.repository;
  const raw = typeof declared === 'string' ? declared : declared?.url;
  if (typeof raw !== 'string' || raw === '') return undefined;
  const url = raw.replace(/^git\+/u, '').replace(/\.git$/u, '');
  if (!URL.canParse(url) || !/^https?:/u.test(url)) return undefined;
  const directory = typeof declared === 'object' && typeof declared.directory === 'string' ? declared.directory : undefined;
  return { url, ...(directory === undefined ? {} : { directory }) };
}

function authorFromManifest(manifest) {
  const author = manifest?.author;
  if (typeof author === 'string' && author.trim() !== '') return author;
  if (isObject(author) && typeof author.name === 'string' && author.name.trim() !== '') return author.name;
  return undefined;
}

function keywordsFromManifest(manifest) {
  if (!Array.isArray(manifest?.keywords)) return undefined;
  const keywords = manifest.keywords.filter((keyword) => typeof keyword === 'string' && keyword !== '');
  return keywords.length === 0 ? undefined : keywords;
}

/**
 * Build the format-1 document.
 * @param catalog result of {@link loadCatalog}.
 * @param documents registry document per npm plugin name.
 * @param icons icon reference per plugin name, already resolved by the caller.
 * @param options.onSkipped called with (name, version) for a published version that is not a bundle.
 */
export function buildDocument(catalog, documents, icons, options = {}) {
  const plugins = catalog.plugins.map((plugin) => {
    let versions;
    let latestManifest;
    if (plugin.git !== undefined) {
      versions = [...plugin.git].sort((left, right) => semver.rcompare(left.version, right.version));
    } else {
      const document = documents[plugin.name];
      if (document === undefined) fail('$.plugins', `no registry document for ${plugin.name}`);
      versions = selectVersions(document, plugin)
        .map((version) => {
          const entry = npmVersionEntry(document, version, plugin);
          if (entry === undefined) options.onSkipped?.(plugin.name, version);
          return entry;
        })
        .filter((entry) => entry !== undefined);
      if (versions.length === 0) {
        fail('$.plugins', `${plugin.name} publishes no version with a dsh.bundle; set requiresBundle: false to index it anyway`);
      }
      latestManifest = document.versions?.[versions[0].version];
    }
    const icon = icons[plugin.name];
    if (typeof icon !== 'string' || icon === '') fail('$.plugins', `no icon resolved for ${plugin.name}`);

    const title = plugin.title ?? { en: shortName(plugin.name) };
    const description = plugin.description ?? (typeof latestManifest?.description === 'string' && latestManifest.description !== ''
      ? { en: latestManifest.description }
      : undefined);
    const homepage = plugin.homepage ?? latestManifest?.homepage;
    const repository = plugin.repository ?? repositoryFromManifest(latestManifest);
    const author = plugin.author ?? authorFromManifest(latestManifest);
    const keywords = plugin.keywords ?? keywordsFromManifest(latestManifest);

    return {
      name: plugin.name,
      title,
      ...(description === undefined ? {} : { description }),
      icon,
      ...(author === undefined ? {} : { author }),
      ...(homepage === undefined ? {} : { homepage }),
      ...(repository === undefined ? {} : { repository }),
      metadata: {
        ...(plugin.category === undefined ? {} : { category: plugin.category }),
        keywords: keywords ?? [],
        labels: plugin.labels ?? [],
        sortKeys: plugin.sortKeys ?? {},
      },
      versions,
    };
  });

  return {
    format: 1,
    title: catalog.title,
    ...(catalog.description === undefined ? {} : { description: catalog.description }),
    metadata: catalog.metadata,
    plugins,
  };
}
