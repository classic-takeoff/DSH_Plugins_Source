# 插件升级

在**已安装插件详情页**的页头加一个「升级最新版本」按钮。

- 打开某个已安装插件的详情页时，插件会读取市场索引，找到同名条目；
- 当市场状态是 `update-available` 时，页头出现「升级最新版本」（悬停同样显示该文案）；
- 点击后：先移除旧版本，再用市场条目的精确 spec 安装新版本（保留原来的启用状态）；
- 市场没有更新、或该插件不在市场里时，不显示按钮。

## 实现

- 注册 `plugins.detail.actions` 槽；owner props 提供 `subject = { kind: "bundle", pkg }`。
- `ctx.remote.pluginMarket.listIndexes()` + `search(url, { sort: { kind: "index" }, limit: 100 })` 找同名条目。
- 升级目标取 `defaultVersion`（缺失时取第一个版本）的 `install.spec`。
- 执行：`pluginManager.removeBundle(name)` → `pluginManager.installBundle(spec, { enabled, requestId, registry? })`。
- 失败会弹原生提示，并说明插件可能已被卸载、需要去「发现」页重装。

## 限制

- 升级过程没有官方安装对话框的进度/审批界面；脚本审批等特殊情况会以失败提示呈现。
- 只处理插件市场里的插件。
