#!/usr/bin/env node
/**
 * Validate an index file against plugin market index format 1.
 *
 *   node scripts/validate.mjs [dist/index.json] [--index-url URL]
 *
 * The same validator DSH runs before showing a market, so a pass here means the file is accepted.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MarketIndexError, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const args = parseArgs(process.argv.slice(2));
const file = path.resolve(ROOT, args._[0] ?? 'dist/index.json');
const sourcesPath = path.join(ROOT, 'sources', 'index.json');
const sources = JSON.parse(await fs.readFile(sourcesPath, 'utf8'));
const indexUrl = String(args['index-url'] ?? sources.indexUrl ?? 'http://127.0.0.1:8787/index.json');

let document;
try {
  document = JSON.parse(await fs.readFile(file, 'utf8'));
} catch (error) {
  console.error(`cannot read ${path.relative(ROOT, file)}: ${error.message}`);
  process.exit(1);
}

try {
  const parsed = parseMarketIndex(document, indexUrl);
  console.log(`valid format 1: ${path.relative(ROOT, file)} (${indexUrl})`);
  console.log(`  title:    ${parsed.title.en}`);
  console.log(`  plugins:  ${String(parsed.plugins.length)}`);
  const versions = parsed.plugins.reduce((total, plugin) => total + plugin.versions.length, 0);
  console.log(`  versions: ${String(versions)}`);
  for (const plugin of parsed.plugins) {
    console.log(`    ${plugin.name.padEnd(52)} ${plugin.versions[0]?.version ?? '-'}`);
  }
} catch (error) {
  if (error instanceof MarketIndexError) {
    console.error(`invalid index: ${error.path} ${error.reason}`);
    process.exit(1);
  }
  throw error;
}
