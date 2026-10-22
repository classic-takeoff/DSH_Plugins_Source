# 插件升级

在 **插件** 页新增一个 **升级** 标签页（位于「已安装」之后）。

它读取已配置的插件市场索引，与本地已安装的插件比较，列出所有 `update-available` 的条目：

- 每行显示名称、已安装版本 → 可升级版本；
- 点「升级」会走插件页自带的安装流程，用该市场条目的精确 spec 覆盖安装（先移除旧版本再安装新版本，保留启用状态）；
- 安装/启用状态变化后自动刷新列表；
- 顶部「刷新」重新读取市场。

## 实现

- 注册 `plugins.tab` 槽，`label: "升级"`、`order: 10`。
- 通过 `ctx.remote.pluginMarket.listIndexes()` + `search(url, {...})` 读取市场条目，按 `installation.status === "update-available"` 过滤。
- 升级目标取条目的 `defaultVersion`（缺失时取第一个兼容版本）的 `install.spec`，交给页面提供的 `install({ spec, registry, title, version })`。
- 订阅 `plugin-manager/changed` 自动刷新。

## 限制

- 只处理插件市场里的插件；本地 `link:` 或其他来源的插件仍走插件页原有的安装/移除流程。
- 升级会重启或重新组合相关插件；是否需要重启由插件页的安装对话框提示。
