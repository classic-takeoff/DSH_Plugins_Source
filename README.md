# DSH plugin index source

A runnable **plugin market index source** for DeepSeek Harness. Write a catalog in `sources/index.json`, pull real versions, publish times and compatibility ranges from the npm registry, emit a [format-1](docs/format-1.md) `dist/index.json`, serve it statically, then add the URL in DSH under **Plugins → Discover → Add index source**.

The catalog starts **empty** (`plugins: []`): it declares a title, categories, labels and a sort key, but no placeholder plugins. An empty index is valid — Discover simply shows nothing — so add your own entries to `sources/index.json` and rebuild.

## Quick start

Node.js 22+ is required for the build and validation steps. `dist/` is plain static output.

```powershell
cd plugin-index
pnpm install            # or: npm install
node scripts/build.mjs  # validates before writing: a bad catalog never reaches dist/
node scripts/serve.mjs  # http://127.0.0.1:8787/index.json
```

Verify end to end (starts its own temporary server):

```powershell
node scripts/check.mjs --spawn
```

Then in DSH: **Plugins → Discover → Add index source** and paste `http://127.0.0.1:8787/index.json`.

## What is here

| Piece | File | Purpose |
|---|---|---|
| Catalog (the only file you edit) | `sources/index.json` | title, categories, labels, sort keys, plugin list |
| Builder | `scripts/build.mjs` | npm metadata, icons, `dist/index.json` |
| Validator | `scripts/validate.mjs` | the same `parseMarketIndex` DSH runs |
| Static server | `scripts/serve.mjs` | no redirects, correct content types, ETag |
| End-to-end check | `scripts/check.mjs` | HTTP contract, format 1, every icon |
| Rules | `lib/catalog.mjs` | version policy, publish time, engines, git sources |
| Tests | `test/` | 15 cases over catalog rules, git install specs, server behaviour |

The build refuses to write a broken index:

- every listed version must declare `dsh.bundle` (otherwise skipped, or `requiresBundle: false`); a plugin with no bundle version fails the build;
- `engines.dsh` must be a SemVer range and not a `workspace:` range;
- icons must be same-origin relative paths, `https:`, or `data:` under 32 KiB;
- the finished document is validated with the real parser, reporting the JSON path of the first violation.

## Adding a plugin

### npm package

```json
{
  "name": "@acme/dsh-hello",
  "title": { "en": "Hello", "zh-cn": "你好" },
  "description": { "en": "A greeting plugin.", "zh-cn": "打招呼插件。" },
  "category": "feature",
  "labels": ["official"],
  "keywords": ["hello"],
  "sortKeys": { "featured": 50 },
  "versions": "all"
}
```

`title` / `description` fall back to the package short name and the npm description; `author`, `homepage` and `repository` (with `directory`) are derived from the registry document. `versions` accepts `"all"`, `"latest"` (the `dist-tags.latest` version) or an exact version array, with optional `maxVersions`. Use `registry` for a private registry, and `requiresBundle: false` to index a package that is not a DSH bundle.

### Git source

```json
{
  "name": "@acme/dsh-hello",
  "title": { "en": "Hello" },
  "git": {
    "url": "https://github.com/acme/dsh-hello",
    "path": "packages/hello",
    "versions": [
      { "version": "1.2.0", "commit": "<40-hex commit>", "publishTimestamp": 1760000000 }
    ]
  }
}
```

installs as `git+https://github.com/acme/dsh-hello.git#<commit>&path:/packages/hello`.

### Icons

Omit `icon` for a deterministic monogram (`icons/<slug>.svg`), or use a relative path such as `assets/hello.svg` (copied into `dist/icons/` and referenced same-origin), an absolute `https:` URL, or a `data:` URL under 32 KiB.

## Adding the index to DSH

Add the URL at runtime (takes effect immediately) via **Plugins → Discover → Add index source**.

To persist it in a profile instead, copy the entry from `examples/plugin-market.patch.yml` into `%DSH_HOME%\profiles\<profile>\cordis.patch.yml` (`$DSH_HOME/profiles/<profile>/cordis.patch.yml` on macOS/Linux) and restart. `indexes` is the complete ordered list, so keep existing URLs. The snippet was verified with DSH's own composer:

```text
dsh --profile <profile> --dump-config
# - id: plugin-market
#   config:
#     indexes:
#       - http://127.0.0.1:8787/index.json
```

## Deploying to GitHub Pages

The repo ships `.github/workflows/pages.yml`: a push to `main` runs **tests → build → validate → deploy `dist/`**, passing the Pages URL to `--index-url`. `dist/` is generated output and is not committed.

1. Create an empty GitHub repository (no README).
2. Initialize and push from `plugin-index/` (substitute your repo URL):

```powershell
git init -b main
git config user.name "Your Name"
git config user.email "you@example.com"
git add .
git commit -m "feat: dsh plugin index source"
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

3. In the repository: **Settings → Pages → Build and deployment → Source** = **GitHub Actions** (once).
4. Wait for the **Deploy plugin index** workflow, then the index lives at `https://<user>.github.io/<repo>/index.json` (`https://<user>.github.io/<repo>/` is the human preview).
5. In DSH: **Plugins → Discover → Add index source**, paste that URL.

Later edits to `sources/index.json` redeploy on push; DSH caches a successful read for 10 minutes (`cacheTtlMs`), so press refresh in Discover.

## Other hosting

- **Object storage / Nginx**: `node scripts/build.mjs --index-url https://your.host/index.json`, then upload `dist/`. DSH rejects redirects, so serve the final URL directly.
- **Local, long-running**: `node scripts/serve.mjs --host 0.0.0.0`.
- **https UI + http index**: an `http:` index is allowed, but a browser blocks `http:` icons from an https page. Relative, same-origin icons (the default here) avoid that entirely.

## Commands

```text
node scripts/build.mjs [--sources FILE] [--out DIR] [--registry URL] [--index-url URL] [--refresh] [--offline]
node scripts/validate.mjs [dist/index.json] [--index-url URL]
node scripts/serve.mjs [--root dist] [--host 127.0.0.1] [--port 8787]
node scripts/check.mjs [--url URL] [--spawn]
node --test --test-isolation=none "test/*.test.mjs"
```

Registry documents are cached in `.cache/registry/`; `--refresh` refetches, `--offline` only reads the cache.

## Notes

- An index is unsigned: its entries are claims. What is installed is decided by the installed package manifest.
- The optional Schedule bundle (`@deepseek-ai/dsh-experimental-schedule-bundle`) was retired in v0.2.0-rc.2; `dsh-web-app` mounts `schedule` and `ui-schedule` itself. Listing it for installation only duplicates those rows, so the starter catalog leaves it out.
- The validator here is the same `lib/index.js` DSH 0.2.1-rc.2 ships (byte-identical to npm `0.2.1-alpha.4`), so passing locally means DSH accepts the document.
