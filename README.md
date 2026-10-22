# DSH Plugins Source

A DeepSeek Harness plugin market index whose content is the plugin packages committed to this repository.

| | |
|---|---|
| Index source | `https://classic-takeoff.github.io/DSH_Plugins_Source/index.json` |
| Human preview | `https://classic-takeoff.github.io/DSH_Plugins_Source/` |
| Install | DSH → **Plugins → Discover → Add index source** → paste the index URL |
| Source of truth | `plugins/<name>/` — one folder per plugin |

Pushes to `main` (or `master`) run the tests, rebuild the index from `plugins/`, validate it with the same parser DSH uses, and deploy it to GitHub Pages. `dist/` is build output and is never committed.

## For agents

Contract for adding, updating or inspecting a plugin.

**Add a plugin** — validates, copies, commits, rebuilds, pushes; CI deploys:

```powershell
node scripts/publish-plugin.mjs C:\path\to\plugin --dry-run   # optional check, changes nothing
node scripts/publish-plugin.mjs C:\path\to\plugin
```

**Or do it by hand** — copy the package into `plugins/<name>/`, then:

```powershell
node scripts/build.mjs
git add plugins/<name>
git commit -m "feat(plugins): add <name>@<version>"
git push
```

Rules the build enforces (violations fail the build; nothing is published):

- `plugins/<folder>/package.json` is valid JSON; `name` is a valid npm name; `version` is exact SemVer.
- `dsh.bundle.patch` points at a file that exists in the folder (normally `./cordis.patch.yml`).
- Dependency ranges must not use `workspace:`, `file:`, `link:` or `portal:`.
- Package names are unique across folders; the folder name should be the package's short name (no scope).
- `dist/` is generated — never edit it, never commit it.

## Repository layout

```text
plugin-index/
├─ plugins/                    # one directory per installable DSH bundle package
│  └─ <name>/                  # package.json, cordis.patch.yml, lib/, dsh-index.json, icon, README
├─ index.config.json           # index title/description, install repository, category/label/sort declarations
├─ lib/
│  ├─ plugins.mjs              # plugin folder rules + format-1 document builder
│  ├─ icons.mjs                # generated monogram icons
│  └─ server.mjs               # static server used by local preview/checks
├─ scripts/
│  ├─ build.mjs                # plugins/ → dist/index.json, validated before writing
│  ├─ publish-plugin.mjs       # copy a local plugin into plugins/, commit, rebuild, push
│  ├─ validate.mjs             # validate an existing dist/index.json
│  ├─ serve.mjs                # serve dist/ over HTTP
│  └─ check.mjs                # HTTP + format + icon checks against a running URL
├─ test/                       # node:test suites
├─ docs/format-1.md            # the index format, field by field
└─ .github/workflows/pages.yml # test → build → validate → deploy to Pages
```

## How the index is built

1. `scripts/build.mjs` scans every direct child folder of `plugins/` that has a `package.json`.
2. Each plugin becomes one index entry. Display metadata comes from `plugins/<name>/dsh-index.json`, falling back to `package.json` fields and a generated icon.
3. The entry's single version is pinned to the commit being built and to `plugins/<name>`:

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
4. The document is validated with `parseMarketIndex` (the parser DSH ships) before `dist/` is written. The commit defaults to `HEAD`; CI passes the pushed SHA explicitly.

Only one version per plugin is listed: the `version` in its `package.json`. Bumping the version and pushing replaces the listed version. If you need a version history, publish the package to npm instead.

## Plugin package requirements

```text
plugins/dsh-hello/
├─ package.json        # required
├─ cordis.patch.yml    # required, named by dsh.bundle.patch
├─ lib/index.js        # required, the package entry point
├─ dsh-index.json      # optional display metadata
├─ icon.svg            # optional icon
└─ README.md           # optional
```

`package.json` must look like a publishable DSH bundle:

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

`dsh-index.json` is optional; every field is optional:

| Field | Meaning |
|---|---|
| `title` | Localized title (a string means English, or an object with lowercase language ids and a required `en`, e.g. `{"en": "Hello", "zh-cn": "你好"}`). |
| `description` | Localized description, same rules. |
| `category` | One id declared in `index.config.json` → `metadata.categories`. |
| `labels` | Ids declared in `metadata.labels`; each may appear once. |
| `keywords` | Free-form search terms. |
| `sortKeys` | Declared sort key ids mapped to finite numbers, e.g. `{"featured": 10}`. |
| `icon` | A relative file inside the folder (`.svg`, `.png`, `.jpg`, `.jpeg`, `.webp`), an `https:` URL, or a `data:` URL up to 32 KiB. Omit for a generated monogram. |
| `author` | Display author. |
| `homepage` | Absolute `http(s)` URL. |

`index.config.json` also declares the index title, the install repository (`repository`) and the URL used by local validation (`indexUrl`). Adding a category or label means adding it there first; otherwise the build rejects the plugin entry.

## Publishing a plugin

`scripts/publish-plugin.mjs` does the whole loop:

1. validates the source directory with the same rules as the build;
2. copies it to `plugins/<name>/` (excluding `node_modules/`, `.git/`, `dist/`, caches);
3. re-scans `plugins/` and refuses duplicates or invalid packages;
4. commits `feat(plugins): add <name>@<version>`;
5. rebuilds and validates the index against the new commit;
6. pushes, which triggers GitHub Actions.

Flags:

| Flag | Effect |
|---|---|
| `--dry-run` | Validate and print the plan; change nothing. |
| `--no-push` | Copy and commit, but do not push. |
| `--no-commit` | Copy only; prints the git commands to run yourself. |
| `--update` | Replace an existing `plugins/<name>/` folder. |
| `--allow-dirty` | Allow unrelated uncommitted changes in this repository. |
| `--message TEXT` | Custom commit message. |

The repository must be clean (commit or stash first) unless `--allow-dirty` is passed, and you must be on `main` or `master` for CI to deploy.

### Updating or removing a plugin

- **Update**: bump `version` in the plugin's `package.json`, then `node scripts/publish-plugin.mjs <path> --update`.
- **Remove**: delete `plugins/<name>/`, commit, push. The next build drops the entry.

## Verify locally

```powershell
node scripts/build.mjs            # builds and validates dist/index.json
node scripts/validate.mjs         # re-validate the built file
node scripts/serve.mjs            # http://127.0.0.1:8787/index.json
node scripts/check.mjs --spawn    # HTTP contract, format, every icon
node --test --test-isolation=none "test/*.test.mjs"
```

`build.mjs` reads the commit and timestamp from git; in an environment without git, pass `--commit <40-hex-sha> --timestamp <unix-seconds>`.

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
| Discover shows no plugins | `plugins/` is empty, or the workflow has not finished. Check the Actions run; DSH caches a successful read for 10 minutes (`cacheTtlMs`) — press refresh. |
| Install fails | The pinned commit must contain `plugins/<name>`. Re-running the workflow rebuilds against the new commit; a force-push invalidates old pins. |
| CI fails at `Test` | Run the test command above locally; fix before pushing. |
| `publish` aborts: working tree dirty | Commit or stash, or pass `--allow-dirty` (the new plugin commit would otherwise include those changes). |
| `publish` aborts: could not read Username | Log in once with `git credential-manager github login`, or push yourself. |
| Icon 404 | The icon must be a file inside the plugin folder, or an `https:`/`data:` URL. Rebuild and redeploy after changing it. |
| `index.config.json: … is not a supported field` | Only `title`, `description`, `repository`, `indexUrl`, `metadata` are allowed. |
| Build: `cannot read git metadata` | Run inside the clone, or pass `--commit` and `--timestamp`. |

## Index format

The published document follows plugin market index format 1. Field-by-field rules, including the git source rules and icon constraints, are in [docs/format-1.md](docs/format-1.md).
