# DSH Plugins Source

A DeepSeek Harness plugin market index built from the package folders in `plugins/`.

| | |
|---|---|
| Index source | `https://classic-takeoff.github.io/DSH_Plugins_Source/index.json` |
| Human preview | `https://classic-takeoff.github.io/DSH_Plugins_Source/` |
| Install | DSH → **Plugins → Discover → Add index source** → paste the index URL |
| Plugin storage | `plugins/<name>/` — one folder per plugin |

Publishing is done entirely by GitHub Actions: push a plugin folder, CI validates it, rebuilds `dist/index.json` and deploys it to Pages. `dist/` is generated and is never committed.

## For agents: upload a plugin

You only need git. Do **not** run node scripts, install dependencies, edit `dist/`, or hand-edit the published index.

### 1. Package the plugin locally into one folder

The folder must be directly installable — everything the plugin needs at runtime is already inside it, with no build step left to run:

```text
dsh-hello/
├─ package.json          # required
├─ cordis.patch.yml      # required, named by dsh.bundle.patch
├─ lib/index.js          # required, the package entry point
├─ dsh-index.json        # optional display metadata
├─ icon.svg              # optional icon
└─ README.md             # optional
```

`package.json` must declare the bundle and an exact version:

```json
{
  "name": "@acme/dsh-hello",
  "version": "1.0.0",
  "description": "Greets the model.",
  "type": "module",
  "main": "lib/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "dsh": ">=0.2.0" }
}
```

Leave out `node_modules/`, `.git/`, caches, tests, and any source that still needs compiling.

### 2. Put the folder in `plugins/<name>/`

`<name>` is the package name without its scope, lower-case: `@acme/dsh-hello` → `plugins/dsh-hello/`. One folder per package; package names must be unique across `plugins/`.

### 3. Commit and push

```powershell
git add plugins/dsh-hello
git commit -m "feat(plugins): add @acme/dsh-hello@1.0.0"
git push
```

Push to `main` (or `master`); other branches do not deploy.

### 4. Let GitHub Actions publish

The **Deploy plugin index** workflow runs the tests, validates every plugin folder, builds the index pinned to your commit, and deploys it. Nothing is published until the run is green. If it fails, read the failing step, fix the folder, commit and push again.

That is the whole agent workflow: **folder → `git add` → `git commit` → `git push`**.

## Local automation (optional)

When the plugin project lives on this machine, one command does validate → copy → commit → rebuild → push:

```powershell
node scripts/publish-plugin.mjs C:\dev\my-plugin --dry-run   # check only, changes nothing
node scripts/publish-plugin.mjs C:\dev\my-plugin
# same: pnpm upload -- C:\dev\my-plugin
```

- The source directory may live inside this repository (for example `.inbox/my-plugin`); its own uncommitted files do not trip the clean-tree guard.
- The task validates the package, copies it to `plugins/<name>/`, commits, rebuilds and validates the index against the new commit, then pushes.
- Flags: `--dry-run` check only; `--no-push` commit without pushing; `--no-commit` copy only; `--update` replace an existing folder; `--allow-dirty` skip the clean-tree guard; `--message` custom commit message.
- Requires a logged-in GitHub CLI credential (`git credential-manager github login`) and a `main`/`master` branch.

GitHub Actions still validates and deploys after the push; if the run fails, fix the plugin and run the task again.

## What CI validates

Every push must satisfy these rules; a violation fails the run and publishes nothing:

- `package.json` is valid JSON, `name` is a valid npm package name, `version` is an exact SemVer version.
- `dsh.bundle.patch` names a file that exists in the folder.
- Dependencies do not use `workspace:`, `file:`, `link:` or `portal:` ranges.
- Package names are unique across `plugins/`.
- Optional `dsh-index.json` only uses declared category, label and sort-key ids, with valid localized text.
- The generated document passes plugin market index format 1.

Failure messages name the folder and field, for example `plugins/dsh-hello/package.json: dsh.bundle.patch must name the bundle patch file`.

## Repository layout

```text
plugin-index/
├─ plugins/                 # one directory per installable DSH bundle package (agents upload here)
├─ index.config.json        # index title/description, install repository, category/label/sort declarations
├─ lib/                     # plugin folder rules and the format-1 document builder
├─ scripts/                 # build/validate/serve/check — used by CI and maintainers
├─ test/                    # node:test suites
├─ docs/format-1.md         # the index format, field by field
└─ .github/workflows/pages.yml  # test → build → validate → deploy to Pages
```

## How the index is built

1. CI scans every direct child folder of `plugins/` that has a `package.json`.
2. Each plugin becomes one index entry; display metadata comes from its `dsh-index.json`, falling back to `package.json` fields and a generated icon.
3. The entry's version is pinned to the commit being built and to `plugins/<name>`:

   ```json
   {
     "version": "1.0.0",
     "publishTimestamp": 1760000000,
     "source": {
       "type": "git",
       "url": "https://github.com/classic-takeoff/DSH_Plugins_Source",
       "commit": "<40-hex commit>",
       "path": "plugins/<name>"
     }
   }
   ```

   DSH installs it as `git+https://github.com/classic-takeoff/DSH_Plugins_Source.git#<commit>&path:/plugins/<name>`.
4. The document is validated with the same parser DSH ships before `dist/` is written.

Only one version per plugin is listed: the `version` in its `package.json`. Bumping the version and pushing replaces the listed version.

## Plugin display metadata (optional)

`plugins/<name>/dsh-index.json`, every field optional:

| Field | Meaning |
|---|---|
| `title` | Localized title: a string means English, or an object with lowercase language ids and a required `en`, e.g. `{"en": "Hello", "zh-cn": "你好"}`. |
| `description` | Localized description, same rules. |
| `category` | One id declared in `index.config.json` → `metadata.categories`. |
| `labels` | Ids declared in `metadata.labels`; each may appear once. |
| `keywords` | Free-form search terms. |
| `sortKeys` | Declared sort key ids mapped to finite numbers, e.g. `{"featured": 10}`. |
| `icon` | A relative file inside the folder (`.svg`, `.png`, `.jpg`, `.jpeg`, `.webp`), an `https:` URL, or a `data:` URL up to 32 KiB. Omit for a generated monogram. |
| `author` | Display author. |
| `homepage` | Absolute `http(s)` URL. |

Categories, labels and sort keys are declared once in `index.config.json`. If a plugin needs a new one, add the declaration in the same commit; an undeclared id fails the build. Omitting `category` and `labels` is always valid.

## Updating or removing a plugin

- **Update**: replace the contents of `plugins/<name>/`, bump `version` in its `package.json`, then `git add plugins/<name> && git commit -m "feat(plugins): update <name>@<version>" && git push`.
- **Remove**: `git rm -r plugins/<name>`, commit and push. The next build drops the entry.

## Maintainers: local checks (optional)

These are not part of the upload flow; CI runs the same steps.

```powershell
pnpm install
node scripts/build.mjs
node scripts/validate.mjs
node scripts/serve.mjs            # http://127.0.0.1:8787/index.json
node scripts/check.mjs --spawn    # HTTP contract, format, every icon
node --test --test-isolation=none "test/*.test.mjs"
```

`build.mjs` reads the commit and timestamp from git; without git, pass `--commit <40-hex-sha> --timestamp <unix-seconds>`.

## Continuous deployment

`.github/workflows/pages.yml` runs on every push to `main`/`master` (and on manual dispatch):

1. `pnpm install --frozen-lockfile`
2. `node --test test/plugins.test.mjs test/server.test.mjs`
3. resolve the Pages base URL
4. `node scripts/build.mjs --commit $GITHUB_SHA --index-url <pages>/index.json`
5. `node scripts/validate.mjs --index-url <pages>/index.json`
6. upload `dist/` and deploy to GitHub Pages

The site must be publicly reachable: DSH fetches the index anonymously, so a private repository needs a plan that supports Pages for private repositories (GitHub Free does not).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Actions run is red | Read the failing step; the message names the folder and field. Fix the folder, commit and push again. |
| Discover shows no plugins | `plugins/` is empty, or the workflow has not finished. DSH caches a successful read for 10 minutes (`cacheTtlMs`) — press refresh. |
| Install fails | The pinned commit must contain `plugins/<name>`. Pushing again rebuilds against the new commit; a force-push invalidates old pins. |
| Icon 404 | The icon must be a file inside the plugin folder, or an `https:`/`data:` URL. Push the fix; CI redeploys. |
| `index.config.json: … is not a supported field` | Only `title`, `description`, `repository`, `indexUrl`, `metadata` are allowed. |
| `git push` rejected | Push to `main`/`master`; a PR or another branch does not deploy. |

## Index format

The published document follows plugin market index format 1. Field-by-field rules, including git source rules and icon constraints, are in [docs/format-1.md](docs/format-1.md).
