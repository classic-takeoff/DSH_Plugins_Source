# DSH 插件源

一个 DeepSeek Harness 插件市场索引，内容来自 `plugins/` 下的插件包文件夹。

| | |
|---|---|
| 索引源 | `https://classic-takeoff.github.io/DSH_Plugins_Source/index.json` |
| 人类预览 | `https://classic-takeoff.github.io/DSH_Plugins_Source/` |
| 安装 | DSH → **插件 → 发现 → 添加索引源** → 粘贴索引地址 |
| 插件存放 | `plugins/<name>/`，一个插件一个文件夹 |

发布完全由 GitHub Actions 完成：推送插件文件夹，CI 校验、重新生成 `dist/index.json` 并部署到 GitHub Pages。`dist/` 是生成物，不提交。

## 给 agent：上传插件

只需要 git。**不要**运行 node 脚本、不要安装依赖、不要改 `dist/`、不要手改已发布的索引。

### 1. 在本地把插件打包成一个文件夹

这个文件夹必须可以直接安装——运行所需的一切都已经在里面，不再需要任何构建步骤：

```text
dsh-hello/
├─ package.json          # 必需
├─ cordis.patch.yml      # 必需，由 dsh.bundle.patch 指向
├─ lib/index.js          # 必需，包的入口
├─ dsh-index.json        # 可选，展示信息
├─ icon.svg              # 可选，图标
└─ README.md             # 可选
```

`package.json` 必须声明组合包和精确版本：

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

不要带 `node_modules/`、`.git/`、缓存、测试，也不要带还需要编译的源码。

### 2. 把文件夹放到 `plugins/<name>/`

`<name>` 是去掉 scope 的包名，小写：`@acme/dsh-hello` → `plugins/dsh-hello/`。一个包一个文件夹，包名在 `plugins/` 内必须唯一。

### 3. 提交并推送

```powershell
git add plugins/dsh-hello
git commit -m "feat(plugins): add @acme/dsh-hello@1.0.0"
git push
```

推送到 `main`（或 `master`）；其他分支不会部署。

### 4. 交给 GitHub Actions 发布

**Deploy plugin index** 工作流会跑测试、校验每个插件文件夹、以本次提交为基准生成索引并部署。只有运行通过才会发布。失败就按失败的步骤修文件夹，再提交推送一次。

agent 的完整流程就这一句：**放文件夹 → `git add` → `git commit` → `git push`**。

## CI 校验什么

每次推送都要满足以下规则，违反任意一条都会让运行失败且不发布：

- `package.json` 是合法 JSON，`name` 是合法 npm 包名，`version` 是精确 SemVer。
- `dsh.bundle.patch` 指向文件夹内真实存在的文件。
- 依赖不能使用 `workspace:`、`file:`、`link:`、`portal:`。
- 包名在 `plugins/` 内唯一。
- 可选的 `dsh-index.json` 只能使用已声明的分类、标签、排序键 id，本地化文本必须合法。
- 生成的文档通过插件市场索引格式 1 校验。

失败信息会指明文件夹和字段，例如 `plugins/dsh-hello/package.json: dsh.bundle.patch must name the bundle patch file`。

## 仓库结构

```text
plugin-index/
├─ plugins/                 # 每个子目录是一个可安装的 DSH 组合包（agent 在这里上传）
├─ index.config.json        # 索引标题/描述、安装仓库、分类/标签/排序键声明
├─ lib/                     # 插件目录规则与格式 1 文档生成
├─ scripts/                 # build/validate/serve/check，供 CI 与维护者使用
├─ test/                    # node:test 用例
├─ docs/format-1.md         # 索引格式逐字段说明
└─ .github/workflows/pages.yml  # 测试 → 构建 → 校验 → 部署 Pages
```

## 索引是怎么生成的

1. CI 扫描 `plugins/` 下每个带 `package.json` 的直接子目录。
2. 每个插件生成一条索引记录；展示信息来自它的 `dsh-index.json`，缺省时回退到 `package.json` 字段和自动生成的图标。
3. 条目里的版本固定到「正在构建的提交」和 `plugins/<name>` 路径：

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
4. 写 `dist/` 之前，用 DSH 自带的那份解析器校验整个文档。

每个插件只列一个版本，即 `package.json` 的 `version`。升版本再推送就会替换列表里的版本。

## 展示信息（可选）

`plugins/<name>/dsh-index.json`，字段全部可选：

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

分类、标签、排序键在 `index.config.json` 里统一声明。插件需要新的 id 时，在同一次提交里加上声明；未声明的 id 会让构建失败。省略 `category`/`labels` 总是合法的。

## 更新与删除

- **更新**：替换 `plugins/<name>/` 的内容，提升 `package.json` 的 `version`，然后 `git add plugins/<name> && git commit -m "feat(plugins): update <name>@<version>" && git push`。
- **删除**：`git rm -r plugins/<name>`，提交并推送；下次构建就不再有该条目。

## 维护者：本地检查（可选）

这些不属于上传流程，CI 会跑同样的步骤。

```powershell
pnpm install
node scripts/build.mjs
node scripts/validate.mjs
node scripts/serve.mjs            # http://127.0.0.1:8787/index.json
node scripts/check.mjs --spawn    # HTTP 契约、格式、每个图标
node --test --test-isolation=none "test/*.test.mjs"
```

`build.mjs` 会从 git 读取提交和时间戳；没有 git 时显式传 `--commit <40 位 SHA> --timestamp <Unix 秒>`。

## 持续部署

`.github/workflows/pages.yml` 在每次推送到 `main`/`master`（以及手动触发）时执行：

1. `pnpm install --frozen-lockfile`
2. `node --test test/plugins.test.mjs test/server.test.mjs`
3. 解析 Pages 基础地址
4. `node scripts/build.mjs --commit $GITHUB_SHA --index-url <pages>/index.json`
5. `node scripts/validate.mjs --index-url <pages>/index.json`
6. 上传 `dist/` 并部署到 GitHub Pages

站点必须公开可读：DSH 匿名抓取索引，所以私有仓库需要支持「私有仓库 Pages」的计划（GitHub Free 不支持）。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| Actions 运行失败 | 看失败的步骤，报错会指明文件夹和字段；修好文件夹再提交推送。 |
| 发现页没有插件 | `plugins/` 为空，或工作流还没跑完。DSH 对成功读取的索引缓存 10 分钟（`cacheTtlMs`），点刷新。 |
| 安装失败 | 固定到的提交里必须包含 `plugins/<name>`。再推一次会用新提交重建；force-push 会让旧索引里的固定提交失效。 |
| 图标 404 | 图标必须是插件目录内的文件，或 `https:`/`data:` URL；推送修复后 CI 会重新部署。 |
| `index.config.json: … is not a supported field` | 只允许 `title`、`description`、`repository`、`indexUrl`、`metadata`。 |
| `git push` 被拒绝 | 要推到 `main`/`master`；PR 或其他分支不会部署。 |

## 索引格式

发布出去的文档遵循插件市场索引格式 1。逐字段规则（包括 Git 源与图标限制）见 [docs/format-1.md](docs/format-1.md)。
