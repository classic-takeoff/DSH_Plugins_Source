# DSH 插件索引源

一个可以直接运行的 **DeepSeek Harness 插件市场索引源**：在 `sources/index.json` 里手写目录，从 npm registry 拉取真实的版本、发布时间与兼容性信息，生成[插件市场索引格式 1](docs/format-1.md) 的 `dist/index.json`，用静态服务器托管，再在 DSH 的「插件 → 发现」里添加这个 URL。

目录默认是**空的**（`plugins: []`）：只声明了标题、分类、标签和排序键，没有任何占位插件。空索引是合法的，发现页显示 0 个插件；把自己的插件加进 `sources/index.json` 后重新构建即可。

## 3 分钟上手

需要 Node.js 22+（`node --version`）。依赖只用于构建和校验，`dist/` 是纯静态文件。

```powershell
cd plugin-index
pnpm install            # 或 npm install
node scripts/build.mjs  # 生成 dist/index.json（构建前先校验，非法目录不会落盘）
node scripts/serve.mjs  # http://127.0.0.1:8787/index.json
```

另开一个终端自检（会自己起一个临时服务器）：

```powershell
node scripts/check.mjs --spawn
```

然后在 DSH 里：**插件 → 发现 → 添加索引源**，粘贴 `http://127.0.0.1:8787/index.json`。

## 这个仓库做了什么

| 部分 | 文件 | 说明 |
|---|---|---|
| 目录（唯一需要手写的文件） | `sources/index.json` | 标题、分类、标签、排序键、插件清单 |
| 生成器 | `scripts/build.mjs` | 拉取 npm 元数据、解析图标、生成 `dist/` |
| 校验 | `scripts/validate.mjs` | 用 DSH 同一个 `parseMarketIndex` 校验 |
| 静态托管 | `scripts/serve.mjs` | 不重定向、正确的 Content-Type、支持 ETag |
| 端到端自检 | `scripts/check.mjs` | HTTP 契约 + 格式 + 每个图标能否加载 |
| 规则库 | `lib/catalog.mjs` | 纯函数：版本策略、发布时刻、引擎范围、Git 源 |
| 测试 | `test/` | 15 个用例：目录规则、Git 安装参数、服务器行为 |

生成器内置的检查（构建时直接报错，不会产出坏索引）：

- 每个版本必须声明 `dsh.bundle`，否则跳过（`requiresBundle: false` 可关闭）；全部版本都不是组合包时构建失败。
- `engines.dsh` 必须是合法 SemVer 范围，且不能是 `workspace:`。
- 图标只能是同源相对路径、`https:` 或 ≤32 KiB 的 `data:` URL。
- 构建完成后用真实校验器跑一遍，`MarketIndexError` 会打印违规值的 JSON 路径。

## 加自己的插件

编辑 `sources/index.json` 的 `plugins` 数组，然后 `node scripts/build.mjs`。

### npm 包（默认）

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

- `title` / `description` 可省略：标题回退到包名短名，描述回退到 npm 的 description。
- `author`、`homepage`、`repository`（含 `directory`）可省略，自动从 npm 元数据推导；`repository.url` 的 `git+` 与 `.git` 会被去掉。
- `versions`：`"all"`（默认，全部版本）、`"latest"`（跟随 `dist-tags.latest`）或精确版本数组；`maxVersions` 可截断。
- `registry`：私有 registry 基址（`https:`/`http:`，不能带凭据、查询或片段）。
- `requiresBundle: false`：索引不是 DSH 组合包的包（默认拒绝）。

### Git 源（未发布到 npm 的插件）

```json
{
  "name": "@acme/dsh-hello",
  "title": { "en": "Hello" },
  "git": {
    "url": "https://github.com/acme/dsh-hello",
    "path": "packages/hello",
    "versions": [
      { "version": "1.2.0", "commit": "<40 位小写 commit SHA>", "publishTimestamp": 1760000000 }
    ]
  }
}
```

安装时生成 `git+https://github.com/acme/dsh-hello.git#<commit>&path:/packages/hello`。`url` 必须是规范化的 https 仓库地址（不能是 tarball，不能带查询/片段），`path` 可省略。

### 图标

- 省略：生成确定性的字母图标（`icons/<slug>.svg`），同名包永远得到同一种颜色。
- 相对路径：如 `"icon": "assets/hello.svg"`，构建时复制到 `dist/icons/`，索引里写相对引用（同源，最稳妥）。
- 绝对 `https:` URL：浏览器直接请求；DSH 页面是 https 时 http 图标会被拦截。
- `data:image/svg+xml;base64,...`：解码后不超过 32 KiB。

### 分类、标签、排序键

先在上层 `metadata` 里声明，插件再引用；引用未声明的 id 会被校验器拒绝：

```json
"metadata": {
  "categories": { "feature": { "title": { "en": "Feature", "zh-cn": "功能" } } },
  "labels": { "experimental": { "title": { "en": "Experimental", "zh-cn": "实验性" } } },
  "sortKeys": { "featured": { "title": { "en": "Featured", "zh-cn": "推荐" }, "order": "desc" } }
}
```

## 在 DSH 里添加索引源

**方式一（推荐，立即生效）**：插件 → 发现 → 添加索引源 → 粘贴 URL。新添加的源会成为当前插件市场，并写入 profile 设置。

**方式二（写进 profile，重启后生效）**：把 `examples/plugin-market.patch.yml` 里的条目合并进 `%DSH_HOME%\profiles\<profile>\cordis.patch.yml`（macOS/Linux 为 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`）。`indexes` 是完整的有序列表，已有 URL 要保留。

这份片段已用 DSH 自己的组合器验证过：

```powershell
dsh --profile <profile> --dump-config
# - id: plugin-market
#   name: '@deepseek-ai/dsh-plugin-market'
#   disabled: !!js '!ctx.get(''profileContext'')'
#   config:
#     indexes:
#       - http://127.0.0.1:8787/index.json
```

## 发布到 GitHub Pages

仓库自带 `.github/workflows/pages.yml`：推送到 `main` 后自动执行 **测试 → 构建 → 校验 → 部署 `dist/`**，并把 Pages 地址作为 `--index-url` 传给构建。`dist/` 是构建产物，不提交到仓库。

1. 在 GitHub 新建一个空仓库，不要勾选初始化 README。
2. 在 `plugin-index/` 里初始化并推送（地址换成你的仓库）：

```powershell
git init -b main
git config user.name "你的名字"
git config user.email "you@example.com"
git add .
git commit -m "feat: dsh plugin index source"
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

3. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**（只需设置一次）。
4. 等工作流 **Deploy plugin index** 完成，索引地址为 `https://<user>.github.io/<repo>/index.json`，根地址 `https://<user>.github.io/<repo>/` 是给人看的预览页。
5. 在 DSH 里 **插件 → 发现 → 添加索引源**，粘贴该地址。

之后修改 `sources/index.json` 并推送，Pages 会自动重建；DSH 侧成功读取的索引缓存 10 分钟（`cacheTtlMs`），点发现页的刷新按钮即可。

## 其他托管方式

- **对象存储 / Nginx**：`node scripts/build.mjs --index-url https://你的域名/index.json` 后上传 `dist/`。DSH 拒绝重定向，索引 URL 必须是最终地址，不能靠 301/302 跳转。
- **本机常驻**：`node scripts/serve.mjs --host 0.0.0.0` 让局域网内其他机器读取；Windows 可用计划任务开机启动。
- **https 页面 + http 索引**：索引本身可以是 `http:`（DSH 允许），但 DSH Web 走 https 时浏览器会拦截 http 图标。本项目默认使用同源相对图标，避免这个问题；换成远程图标时请用 `https:`。

## 命令

```text
node scripts/build.mjs [--sources FILE] [--out DIR] [--registry URL] [--index-url URL] [--refresh] [--offline]
node scripts/validate.mjs [dist/index.json] [--index-url URL]
node scripts/serve.mjs [--root dist] [--host 127.0.0.1] [--port 8787]
node scripts/check.mjs [--url URL] [--spawn]
node --test --test-isolation=none "test/*.test.mjs"
```

`build` 默认缓存 npm 文档到 `.cache/registry/`，重复构建不再联网；`--refresh` 重新拉取，`--offline` 只用缓存。

## 常见问题

- **「发现」里显示读取失败**：先跑 `node scripts/check.mjs`，确认 URL 可访问且格式有效；错误会带上 `$.plugins[...]` 这类 JSON 路径。
- **发现页是空的**：目录里没有插件（`plugins: []`）。格式 1 允许空索引，只是没有可展示的卡片；把插件加进 `sources/index.json` 后重新构建并推送即可。
- **添加后没有变化**：DSH 对成功读取的索引缓存 10 分钟（`cacheTtlMs`），点发现页的刷新按钮或改配置后重启。
- **图标 404**：`dist/icons/` 没有一起部署，或 `--index-url` 与部署地址的主机不一致导致相对路径解析到别处。
- **版本缺失**：未声明 `dsh.bundle` 的版本会被跳过，构建日志会打印 `skip <name>@<version> (not a bundle)`。
- **为什么没有 Schedule 组合包**：`@deepseek-ai/dsh-experimental-schedule-bundle` 已在 v0.2.0-rc.2 退役，「自动化任务」由 `@deepseek-ai/dsh-web-app` 直接挂载（`schedule` + `ui-schedule`）。不要再把它加进目录：重复挂载只会产生多余的行。
- **升级**：插件市场目前只显示 `有新版本`，升级需要先卸载再安装。
- **索引很大**：`maxVersions` 控制每个包的版本数；DSH 单份索引上限 128 MiB，但实际应远小于此。

## 说明

- 索引没有签名：索引内容（包括 Git 条目的名称和版本）是市场方的声明，真正安装什么由包自身的 manifest 决定。
- 校验器与 DSH 0.2.1-rc.2 内置实现是同一份 `lib/index.js`（与 npm `0.2.1-alpha.4` 逐字节一致），所以本地通过即代表 DSH 接受。
