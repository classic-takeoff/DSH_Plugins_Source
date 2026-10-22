/** npm registry access: one cached JSON document per package. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { CatalogError } from './catalog.mjs';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const TIMEOUT_MS = 30_000;
const ATTEMPTS = 3;

/** Validate and canonicalize a registry base URL. */
export function normalizeRegistry(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CatalogError('--registry', 'must be an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CatalogError('--registry', 'must use https: or http:');
  if (url.username !== '' || url.password !== '') throw new CatalogError('--registry', 'must not contain credentials');
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
}

/** The cache file for one package: readable, unique, and inside the cache directory. */
export function cacheFile(cacheDir, name) {
  return path.join(cacheDir, `${name.replace(/^@/u, '').replace(/[^a-z0-9._-]+/giu, '-')}.json`);
}

async function readCache(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function fetchDocument(url) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 404) throw new CatalogError('--registry', `package not found: ${url}`);
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      return JSON.parse(await response.text());
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      lastError = error;
      if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw new Error(`GET ${url} failed after ${String(ATTEMPTS)} attempts: ${lastError?.message ?? 'unknown error'}`);
}

/**
 * Read one package document, using the on-disk cache unless `refresh` is set.
 * @returns {Promise<object>} the registry document (all versions, times, dist-tags).
 */
export async function readPackageDocument(name, { registry, cacheDir, refresh = false, offline = false }) {
  const file = cacheFile(cacheDir, name);
  const cached = await readCache(file);
  if (cached !== undefined && (!refresh || offline)) return cached;
  if (offline) throw new Error(`offline and no cached document for ${name} (${file})`);

  const document = await fetchDocument(`${registry}/${encodeURIComponent(name)}`);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  return document;
}

/** Map with a fixed concurrency, preserving order. */
export async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
