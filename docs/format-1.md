# 插件市场索引格式 1

DSH 用 `@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex(document, indexUrl)` 读取索引。本文件是那份实现（0.2.1-rc.2，与 npm `0.2.1-alpha.4` 同一份 `lib/index.js`）的规则摘要，逐条对应它会拒绝的输入。

## 顶层

| 字段 | 必填 | 规则 |
|---|---|---|
| `format` | 是 | 必须等于 `1`（数字）。 |
| `title` | 是 | 本地化文本。 |
| `description` | 否 | 本地化文本。 |
| `metadata` | 否 | 见下；缺省时补成三个空分组。 |
| `plugins` | 是 | 数组，可以为空（空索引合法）；`name` 不允许重复。 |

格式未定义的成员会被丢弃，不会报错。

## 本地化文本

- 字符串：视为英文，例如 `"title": "Hello"`。
- 对象：键是小写语言 id，匹配 `^[a-z]{2,8}(-[a-z0-9]{1,8})*$`，**必须含 `en`**，每个值非空。
  正确：`{"en": "Hello", "zh-cn": "你好"}`；错误：`"zh-CN"`（大写会被拒绝）。

## `metadata`

```json
{
  "categories": { "feature": { "title": { "en": "Feature" } } },
  "labels": { "experimental": { "title": { "en": "Experimental" } } },
  "sortKeys": { "featured": { "title": { "en": "Featured" }, "order": "desc" } }
}
```

- `categories` / `labels`：id 非空，值只有 `title`（本地化）。
- `sortKeys`：值必须带 `order`，取 `"asc"` 或 `"desc"`。

## 插件条目

| 字段 | 必填 | 规则 |
|---|---|---|
| `name` | 是 | 合法 npm 包名，≤214 字符，同一索引内唯一。 |
| `title` | 否 | 本地化文本。 |
| `description` | 否 | 本地化文本。 |
| `icon` | 否 | 见「图标」。 |
| `author` | 否 | 非空字符串。 |
| `homepage` | 否 | 绝对 `http:` / `https:` URL；允许 query 与 fragment（`#readme` 常见）。 |
| `repository` | 否 | `{ "url": 绝对 http(s), "directory"?: 相对目录 }`。 |
| `metadata` | 否 | `category`（须在 `metadata.categories` 中声明）、`keywords`（字符串数组）、`labels`（须声明、不重复）、`sortKeys`（键须声明，值为有限数字）。 |
| `versions` | 是 | 非空数组，`version` 不重复；读出后按 SemVer 降序。 |

## 版本条目

| 字段 | 必填 | 规则 |
|---|---|---|
| `version` | 是 | 精确 SemVer 2.0.0（不接受范围）。 |
| `publishTimestamp` | 是 | Unix **秒**整数，范围 `[0, 10^11)`。 |
| `source` | 是 | `npm` 或 `git`，见下。 |
| `engines` | 否 | `{ "dsh": SemVer 范围 }`，不能是 `workspace:` 范围。 |

### npm 源

```json
{ "type": "npm", "registry": "https://registry.example.com" }
```

`registry` 可选，须为绝对 `http(s)` URL，且不含凭据、查询、片段。

### Git 源

```json
{ "type": "git", "url": "https://github.com/acme/plugin", "commit": "<40 位小写 hex>", "path": "packages/plugin" }
```

- `url`：https、规范化（必须与输入字符串完全一致，不能带 `git+`、末尾斜杠、查询或片段）、至少两段路径、不能是 `.tgz` / `.tar.gz`。
- `commit`：小写 40 位十六进制。
- `path`：可选，相对目录，段只允许字母、数字与 `._@+-`，不能有 `.` / `..` / 空段。

## 图标

- `data:` URL：`data:image/(svg+xml|png|jpeg|webp);base64,...`，解码后 ≤32 KiB。
- 其他值按 URL 引用处理：相对路径基于**索引 URL** 解析，结果必须是 `https:` 或与索引**同源**（索引为 `http://127.0.0.1:8787` 时，`icons/x.svg` 解析为同源 http，合法）。

## 安装参数

`marketInstallTarget(name, version)` 生成安装目标：

- npm：`name@version`，若版本声明了 `registry`，安装时优先询问该 registry。
- Git：`git+<url>.git#<commit>`，带包目录时追加 `&path:/<path>`。

## 校验器的其他行为

- 填充缺省值：`metadata` 三个分组、`keywords` / `labels` / `sortKeys` / `engines`。
- 把每个插件的 `versions` 按 SemVer 优先级降序重排。
- 把相对 `icon` 替换成绝对 URL（因此校验器输出的文档不能原样写回静态文件）。
- 遇到第一条违规就抛 `MarketIndexError`，带 `path`（如 `$.plugins[0].versions[1].version`）和 `reason`。

## 本仓库的对应实现

`plugins/<name>/` 目录 → `scripts/build.mjs`（每个条目固定到 `--commit` 与 `plugins/<name>` 路径）→ `parseMarketIndex` 校验 → 通过后才写 `dist/`。`scripts/validate.mjs` 可以对任意已生成文件重复这一步；`scripts/check.mjs --spawn` 还会校验 HTTP 层（不重定向、JSON Content-Type、严格 UTF-8）与每个图标的可加载性。`scripts/publish-plugin.mjs` 负责把本地插件目录复制进 `plugins/`、提交、重建并推送。
