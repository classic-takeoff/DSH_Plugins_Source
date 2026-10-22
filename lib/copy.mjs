/** Copy one plugin package folder, leaving out build and VCS noise. */
import fs from 'node:fs/promises';
import path from 'node:path';

export const PLUGIN_EXCLUDES = new Set(['node_modules', '.git', '.cache', '.pnpm-store', 'dist', 'coverage', '.turbo', '.DS_Store']);

/** Copy every entry of `source` into `target`, skipping excluded names. */
export async function copyPluginTree(source, target, excludes = PLUGIN_EXCLUDES) {
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (excludes.has(entry.name)) continue;
    await fs.cp(path.join(source, entry.name), path.join(target, entry.name), {
      recursive: true,
      dereference: false,
      force: true,
    });
  }
}
