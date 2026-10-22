# 简洁思考模式（Concise Thinking）

工作步骤展示的「只思考」视图。

开关在 **设置 → 通用**，紧跟在「工作步骤展示」下方，名称是 **简洁思考模式**，右侧是与「显示代码工作视图」相同样式的开关（复用官方 primitives 的 `Switch`）。开启后：

- 隐藏所有工具调用行（`data-chat-flow-kind="tool-call"`），过程区只剩思考。
- 自动展开思考行，并替换思考正文为**不换行**的单行文本，可横向滚动查看完整内容。
- 关闭后立即恢复官方渲染，不写入任何 Host 设置。

## 为什么不是下拉里的第五项

`工作步骤展示` 的可选值是 ui-chat 内置的固定枚举（compact/standard/detailed/verbose），Host 的 settings schema 会拒绝其它值，插件无法合法写入自定义的 `transcriptView`。所以这个插件用独立开关实现相同的显示效果，开关位置就在该设置行下方。

## 实现方式

- 浏览器入口注册 `conversation.chat.reasoning.body`（priority 90，低于官方的 100）替换思考正文；关闭时回退到官方 `conversation.chat.reasoning.content` 工厂。
- 一段 CSS 在 `html[data-dsh-thinking]` 下隐藏工具调用行。
- `MutationObserver` 在开启时展开新出现的思考行（点击其 `aria-expanded="false"` 触发器）。
- 偏好保存在 `localStorage` 的 `dsh.thinking-mode`。

## 已知限制

- 依赖聊天 DOM 的属性（`data-variant="think"`、`data-chat-flow-kind`、`aria-expanded`），Harness 升级若改动这些标记，需要同步更新插件。
- 开启时思考行会被强制展开，手动折叠会在下一次 DOM 变化时被重新打开。
- 不修改已记录的会话数据，只影响显示。
