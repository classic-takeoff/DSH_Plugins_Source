# DSH 插件源

一个 DeepSeek Harness 插件市场索引，内容就是本仓库里提交的插件包。

| | |
|---|---|
| 索引源 | `https://classic-takeoff.github.io/DSH_Plugins_Source/index.json` |
| 人类预览 | `https://classic-takeoff.github.io/DSH_Plugins_Source/` |
| 安装 | DSH → **插件 → 发现 → 添加索引源** → 粘贴上面的地址 |
| 唯一事实来源 | `plugins/<name>/`，一个插件一个文件夹 |

推送到 `main`（或 `master`）后，工作流会跑测试、从 `plugins/` 重新生成索引、用 DSH 同一个解析器校验，并部署到 GitHub Pages。`dist/` 是构建产物，不提交。

## 给 agent 的约定

这是新增、更新、检查插件时的最小约定。

**新增插件**（校验 → 复制 → 提交 → 重建 → 推送；CI 负责部署）：

```powershell
node scripts/publish-plugin.mjs C:\path\to\plugin --dry-run   # 可选：只检查，不改动
node scripts/publish-plugin.mjs C:\path\to\plugin
```

**或者手动做**：把插件包复制成 `plugins/<name>/`，然后：

```powershell
node scripts/build.mjs
git add plugins/<name>
git commit -m "feat(plugins): add <name>@<version>"
git push
```

构建会强制这些规则（违反即失败，不会发布）：

- `plugins/<folder>/package.json` 是合法 JSON，`name` 是合法 npm 包名，`version` 是精确 SemVer。
- `dsh.bundle.patch` 指向目录内真实存在的文件（通常是 `./cordis.patch.yml`）。
- 依赖不能使用 `workspace:`、`file:`、`link:`、`portal:`。
- 包名在所有文件夹中唯一；文件夹名用包名短名（不带 scope）。
- `dist/` 是生成物，永远不要手改、不要提交。

## 仓库结构

```text
plugin-index/
├─ plugins/                    # 每个子目录是一个可安装的 DSH 组合包
│  └─ <name>/                  # package.json、cordis.patch.yml、lib/、dsh-index.json、图标、README
├─ index.config.json           # 索引标题/描述、安装仓库地址、分类/标签/排序键声明
├─ lib/
│  ├─ plugins.mjs              # 插件目录规则 + 格式 1 文档生成
│  ├─ icons.mjs                # 自动生成的字母图标
│  └─ server.mjs               # 本地预览/自检用的静态服务器
├─ scripts/
│  ├─ build.mjs                # plugins/ → dist/index.json，写盘前先校验
│  ├─ publish-plugin.mjs       # 复制本地插件进 plugins/、提交、重建、推送
│  ├─ validate.mjs             # 校验已有的 dist/index.json
│  ├─ serve.mjs                # 用 HTTP 提供 dist/
│  └─ check.mjs                # 对运行中的 URL 做 HTTP/格式/图标检查
├─ test/                       # node:test 用例
├─ docs/format-1.md            # 索引格式逐字段说明
└─ .github/workflows/pages.yml # 测试 → 构建 → 校验 → 部署 Pages
```

## 索引是怎么生成的

1. `scripts/build.mjs` 扫描 `plugins/` 下每个带 `package.json` 的直接子目录。
2. 每个插件生成一条索引记录；展示信息来自 `plugins/<name>/dsh-index.json`，缺省时回退到 `package.json` 字段和自动生成的图标。
3. 条目里唯一的版本固定到「正在构建的提交」和 `plugins/<name>` 路径：

   ```json
   {
     "version": "1.0.0",
     "publishTimestamp": 1760000000,
     "source": {
       "type": "git",
       "url": "https://github.com/classic-takeoff/DSH_Plugins_Source",
       "commit": "<40 位提交>",
       "path": "plugins/<name>"
     }
   }
   ```

   DSH 安装时使用 `git+https://github.com/classic-takeoff/DSH_Plugins_Source.git#<commit>&path:/plugins/<name>`。
4. 写 `dist/` 之前用 `parseMarketIndex`（DSH 自带的那份解析器）校验。提交默认取 `HEAD`，CI 显式传入本次推送的 SHA。

每个插件只列一个版本，即 `package.json` 的 `version`。升版本后推送就会替换列表里的版本。需要保留历史版本的话，请改为发布到 npm。

## 插件包要求

```text
plugins/dsh-hello/
├─ package.json        # 必需
├─ cordis.patch.yml    # 必需，由 dsh.bundle.patch 指向
├─ lib/index.js        # 必需，包的入口
├─ dsh-index.json      # 可选，展示信息
├─ icon.svg            # 可选，图标
└─ README.md           # 可选
```

`package.json` 必须像一个可发布的 DSH 组合包：

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

`dsh-index.json` 可选，字段也全部可选：

| 字段 | 含义 |
|---|---|
| `title` | 本地化标题：字符串视为英文，或使用小写语言 id 的对象且必须含 `en`，例如 `{"en": "Hello", "zh-cn": "你好"}`。 |
| `description` | 本地化描述，规则同上。 |
| `category` | 一个在 `index.config.json` → `metadata.categories` 里声明的 id。 |
| `labels` | 在 `metadata.labels` 里声明的 id，不可重复。 |
| `keywords` | 自由搜索词。 |
| `sortKeys` | 已声明的排序键 → 有限数字，例如 `{"featured": 10}`。 |
| `icon` | 目录内的相对文件（`.svg`/`.png`/`.jpg`/`.jpeg`/`.webp`）、`https:` URL，或不超过 32 KiB 的 `data:` URL；省略则自动生成字母图标。 |
| `author` | 展示作者。 |
| `homepage` | 绝对 `http(s)` URL。 |

`index.config.json` 还声明索引标题、安装仓库（`repository`）和本地校验用的地址（`indexUrl`）。新增分类或标签必须先加到这里，否则构建会拒绝插件条目。

## 发布插件

`scripts/publish-plugin.mjs` 一次做完这些事：

1. 用与构建相同的规则校验源目录；
2. 复制到 `plugins/<name>/`（排除 `node_modules/`、`.git/`、`dist/`、缓存）；
3. 重新扫描 `plugins/`，拒绝重名或非法包；
4. 提交 `feat(plugins): add <name>@<version>`；
5. 针对新提交重建并校验索引；
6. 推送，触发 GitHub Actions。

参数：

| 参数 | 作用 |
|---|---|
| `--dry-run` | 只校验并打印计划，不改动任何文件。 |
| `--no-push` | 复制并提交，但不推送。 |
| `--no-commit` | 只复制，并打印需要自己执行的 git 命令。 |
| `--update` | 覆盖已存在的 `plugins/<name>/`。 |
| `--allow-dirty` | 允许仓库里存在无关的未提交改动。 |
| `--message TEXT` | 自定义提交信息。 |

除非传 `--allow-dirty`，仓库必须是干净的（先 commit 或 stash）；要 CI 部署，当前分支必须是 `main` 或 `master`。

### 更新与删除

- **更新**：修改插件 `package.json` 的 `version`，然后 `node scripts/publish-plugin.mjs <path> --update`。
- **删除**：删掉 `plugins/<name>/`，提交并推送，下次构建就不再包含该条目。

## 本地验证

```powershell
node scripts/build.mjs            # 生成并校验 dist/index.json
node scripts/validate.mjs         # 再校验已生成的文件
node scripts/serve.mjs            # http://127.0.0.1:8787/index.json
node scripts/check.mjs --spawn    # HTTP 契约、格式、每个图标
node --test --test-isolation=none "test/*.test.mjs"
```

`build.mjs` 会从 git 读取提交和时间戳；在没有 git 的环境里，显式传 `--commit <40 位 SHA> --timestamp <Unix 秒>`。

## 持续部署

`.github/workflows/pages.yml` 在每次推送到 `main`/`master`（以及手动触发）时执行：

1. `pnpm install --frozen-lockfile`
2. `node --test test/plugins.test.mjs test/server.test.mjs`
3. 解析 Pages 基础地址
4. `node scripts/build.mjs --commit $GITHUB_SHA --index-url <pages>/index.json`
5. `node scripts/validate.mjs --index-url <pages>/index.json`
6. 上传 `dist/` 并部署到 GitHub Pages

站点必须公开可读：DSH 是匿名抓取索引的，所以私有仓库需要支持「私有仓库 Pages」的计划（GitHub Free 不支持）。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 发现页没有插件 | `plugins/` 为空，或工作流还没跑完。看 Actions 运行结果；DSH 对成功读取的索引缓存 10 分钟（`cacheTtlMs`），点刷新。 |
| 安装失败 | 固定到的提交里必须包含 `plugins/<name>`。重跑工作流会用新提交重建；force-push 会让旧索引里的固定提交失效。 |
| CI 在 `Test` 失败 | 本地跑上面的测试命令，修好再推。 |
| `publish` 报工作区不干净 | 先提交/暂存，或传 `--allow-dirty`（否则新提交会带上那些改动）。 |
| `publish` 报 could not read Username | 先登录一次 `git credential-manager github login`，或自己 push。 |
| 图标 404 | 图标必须是插件目录内的文件，或 `https:`/`data:` URL；改完要重新构建部署。 |
| `index.config.json: … is not a supported field` | 只允许 `title`、`description`、`repository`、`indexUrl`、`metadata`。 |
| 构建报 `cannot read git metadata` | 在克隆目录里运行，或显式传 `--commit` 和 `--timestamp`。 |

## 索引格式

发布出去的文档遵循插件市场索引格式 1。逐字段规则（包括 Git 源与图标限制）见 [docs/format-1.md](docs/format-1.md)。
