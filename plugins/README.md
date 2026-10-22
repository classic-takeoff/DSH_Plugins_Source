# plugins/

每个子目录就是一个可安装的 DSH 组合包（bundle）。目录名用包名的短名（去掉 scope，小写），例如包 `@acme/dsh-hello` 放在 `plugins/dsh-hello/`。

```text
plugins/
└─ hello/
   ├─ package.json        # 必须：name、version、dsh.bundle.patch、engines.dsh（可选）
   ├─ cordis.patch.yml    # 必须：被 dsh.bundle.patch 指向
   ├─ lib/index.js        # 插件入口（package.json 的 main/exports）
   ├─ dsh-index.json      # 可选：市场里的标题、描述、分类、标签、图标
   ├─ icon.svg            # 可选：图标，或用 dsh-index.json 的 icon 字段
   └─ README.md           # 可选：给人看的说明
```

## 硬性要求

- `package.json` 是合法 JSON，`name` 是合法 npm 包名，`version` 是精确 SemVer。
- 声明 `dsh.bundle.patch`（例如 `"./cordis.patch.yml"`），且该文件存在——否则装不成组合包。
- 依赖里不能出现 `workspace:`、`file:`、`link:`、`portal:`，git 安装无法解析这些协议。
- 目录里不要放 `node_modules/`、`.git/`、`dist/`、缓存；发布脚本会自动排除。

## dsh-index.json（可选）

```json
{
  "title": { "en": "Hello", "zh-cn": "你好" },
  "description": { "en": "Greets the model.", "zh-cn": "向模型问好。" },
  "category": "tools",
  "labels": ["stable"],
  "keywords": ["hello", "greeting"],
  "sortKeys": { "featured": 10 },
  "author": "acme",
  "homepage": "https://github.com/acme/dsh-hello",
  "icon": "icon.svg"
}
```

- 语言键必须是小写（`zh-cn`，不是 `zh-CN`），且必须含 `en`。
- `category`、`labels`、`sortKeys` 的 id 必须在 `../index.config.json` 的 `metadata` 里声明。
- 不写 `dsh-index.json` 时：标题回退到包名短名，描述回退到 `package.json` 的 `description`，图标自动生成。

## 怎么加插件

推荐用发布任务（校验 → 复制 → 提交 → 构建 → 推送）：

```powershell
node scripts/publish-plugin.mjs C:\dev\my-plugin
```

也可以手动：把插件目录复制成 `plugins/<name>/`，然后 `node scripts/build.mjs` 校验，提交并推送。GitHub Actions 会用这次推送的 commit 重新生成索引并发布。
